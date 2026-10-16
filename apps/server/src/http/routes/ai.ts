import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/crypto.js'
import { one, q } from '../../lib/db.js'
import { enqueue } from '../../lib/jobs.js'
import { audit } from '../../ops/audit.js'
import { buildHandoffCard, suggestReply } from '../../ai/agent.js'
import { checkCompliance, RULE_LABEL } from '../../ai/guard.js'
import { extractText, formatKbContext, searchKb } from '../../ai/kb.js'
import { ping } from '../../ai/providers.js'
import { activeCriteria, computeScore } from '../../ai/qualification.js'
import { invalidateAiCache } from '../../ai/router.js'
import { badRequest, notFound } from '../errors.js'
import { clientIp, currentUser, requirePermission, requireRole } from '../app.js'

const uuid = z.string().uuid()
const TASKS = ['triage', 'agent', 'guard', 'summary', 'transcription', 'embedding'] as const

export async function aiRoutes(app: FastifyInstance) {
  // ============================================================ provedores
  app.get('/api/ai/providers', async (req) => {
    requireRole(req, 'admin')
    const rows = await q<any>(`SELECT * FROM ai_providers ORDER BY created_at`)
    return rows.map((r) => {
      let masked = ''
      try {
        masked = maskSecret(decryptSecret(r.api_key_enc))
      } catch {
        masked = '(chave ilegível — cadastre novamente)'
      }
      return { ...r, api_key_enc: undefined, api_key_masked: masked }
    })
  })

  const providerBody = z.object({
    name: z.string().min(2).max(60),
    kind: z.enum(['anthropic', 'openai', 'gemini', 'openai_compatible', 'mock']),
    apiKey: z.string().max(400).optional(),
    baseUrl: z.string().url().nullable().optional().or(z.literal('')),
    enabled: z.boolean().default(true),
  })

  app.post('/api/ai/providers', async (req) => {
    const me = requireRole(req, 'admin')
    const b = providerBody.parse(req.body)
    const r = await one<any>(`INSERT INTO ai_providers(name, kind, api_key_enc, base_url, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
      b.name,
      b.kind,
      b.apiKey ? encryptSecret(b.apiKey.trim()) : null,
      b.baseUrl || null,
      b.enabled,
    ])
    invalidateAiCache()
    await audit({ userId: me.id, action: 'ai.provider_created', entity: 'ai_provider', entityId: r.id, data: { kind: b.kind, name: b.name }, ip: clientIp(req) })
    return r
  })

  app.put('/api/ai/providers/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = providerBody.parse(req.body)
    await q(
      `UPDATE ai_providers SET name=$2, kind=$3, base_url=$4, enabled=$5, api_key_enc = CASE WHEN $6::text IS NULL THEN api_key_enc ELSE $6 END WHERE id=$1`,
      [id, b.name, b.kind, b.baseUrl || null, b.enabled, b.apiKey ? encryptSecret(b.apiKey.trim()) : null],
    )
    invalidateAiCache()
    await audit({ userId: me.id, action: 'ai.provider_updated', entity: 'ai_provider', entityId: id, data: { keyChanged: !!b.apiKey }, ip: clientIp(req) })
    return { ok: true }
  })

  app.delete('/api/ai/providers/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM ai_providers WHERE id=$1`, [id])
    invalidateAiCache()
    await audit({ userId: me.id, action: 'ai.provider_deleted', entity: 'ai_provider', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/ai/providers/:id/test', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { model } = z.object({ model: z.string().min(1) }).parse(req.body)
    const p = await one<any>(`SELECT * FROM ai_providers WHERE id=$1`, [id])
    if (!p) throw notFound()
    const t0 = Date.now()
    try {
      const answer = await ping(p, model)
      return { ok: true, answer, ms: Date.now() - t0 }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err), ms: Date.now() - t0 }
    }
  })

  // ============================================================ modelo por tarefa
  app.get('/api/ai/tasks', async (req) => {
    requireRole(req, 'admin')
    return q(`SELECT * FROM ai_task_models ORDER BY array_position(ARRAY['triage','agent','guard','summary','transcription','embedding'], task)`)
  })

  app.put('/api/ai/tasks/:task', async (req) => {
    const me = requireRole(req, 'admin')
    const { task } = z.object({ task: z.enum(TASKS) }).parse(req.params)
    const b = z
      .object({
        providerId: uuid.nullable(),
        model: z.string().max(120).nullable(),
        fallbackProviderId: uuid.nullable(),
        fallbackModel: z.string().max(120).nullable(),
        temperature: z.number().min(0).max(2).default(0.3),
        maxTokens: z.number().int().min(0).max(32000).default(1024),
      })
      .parse(req.body)
    await q(
      `INSERT INTO ai_task_models(task, provider_id, model, fallback_provider_id, fallback_model, temperature, max_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (task) DO UPDATE SET provider_id=EXCLUDED.provider_id, model=EXCLUDED.model, fallback_provider_id=EXCLUDED.fallback_provider_id,
         fallback_model=EXCLUDED.fallback_model, temperature=EXCLUDED.temperature, max_tokens=EXCLUDED.max_tokens, updated_at=now()`,
      [task, b.providerId, b.model, b.fallbackProviderId, b.fallbackModel, b.temperature, b.maxTokens],
    )
    invalidateAiCache()
    await audit({ userId: me.id, action: 'ai.task_updated', entity: 'ai_task', entityId: task, data: { model: b.model, fallback: b.fallbackModel }, ip: clientIp(req) })
    return { ok: true }
  })

  app.get('/api/ai/usage', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const days = z.object({ days: z.coerce.number().min(1).max(90).default(7) }).parse(req.query).days
    const byTask = await q(
      `SELECT task, provider_kind, model, count(*) AS calls, count(*) FILTER (WHERE NOT ok) AS errors, count(*) FILTER (WHERE fallback_used) AS fallbacks,
              coalesce(sum(input_tokens),0) AS input_tokens, coalesce(sum(output_tokens),0) AS output_tokens, round(avg(latency_ms)) AS avg_ms
         FROM ai_usage WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1,2,3 ORDER BY calls DESC`,
      [String(days)],
    )
    const recentErrors = await q(`SELECT task, model, error, created_at FROM ai_usage WHERE NOT ok ORDER BY id DESC LIMIT 10`)
    return { byTask, recentErrors }
  })

  // ============================================================ agentes
  app.get('/api/ai/agents', async (req) => {
    currentUser(req)
    return q(`SELECT * FROM ai_agents ORDER BY is_default DESC, name`)
  })

  const agentBody = z.object({
    name: z.string().min(2).max(80),
    persona: z.string().max(4000),
    objective: z.string().max(2000),
    instructions: z.string().max(8000),
    kbEnabled: z.boolean().default(true),
    qualificationEnabled: z.boolean().default(true),
    allowedQueryIds: z.array(uuid).default([]),
    maxTurns: z.number().int().min(1).max(100).default(14),
    isDefault: z.boolean().default(false),
    active: z.boolean().default(true),
  })

  app.post('/api/ai/agents', async (req) => {
    const me = requireRole(req, 'admin')
    const b = agentBody.parse(req.body)
    if (b.isDefault) await q(`UPDATE ai_agents SET is_default=false`)
    const r = await one(
      `INSERT INTO ai_agents(name, persona, objective, instructions, kb_enabled, qualification_enabled, allowed_query_ids, max_turns, is_default, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [b.name, b.persona, b.objective, b.instructions, b.kbEnabled, b.qualificationEnabled, b.allowedQueryIds, b.maxTurns, b.isDefault, b.active],
    )
    await audit({ userId: me.id, action: 'ai.agent_created', entity: 'ai_agent', entityId: r.id, data: { name: b.name }, ip: clientIp(req) })
    return r
  })

  app.put('/api/ai/agents/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = agentBody.parse(req.body)
    if (b.isDefault) await q(`UPDATE ai_agents SET is_default=false WHERE id<>$1`, [id])
    await q(
      `UPDATE ai_agents SET name=$2, persona=$3, objective=$4, instructions=$5, kb_enabled=$6, qualification_enabled=$7, allowed_query_ids=$8,
              max_turns=$9, is_default=$10, active=$11, updated_at=now() WHERE id=$1`,
      [id, b.name, b.persona, b.objective, b.instructions, b.kbEnabled, b.qualificationEnabled, b.allowedQueryIds, b.maxTurns, b.isDefault, b.active],
    )
    await audit({ userId: me.id, action: 'ai.agent_updated', entity: 'ai_agent', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ base de conhecimento
  app.get('/api/kb/documents', async (req) => {
    currentUser(req)
    return q(`SELECT id, title, source, url, mime, filename, status, error, chars, chunks, active, refresh_days, last_fetched_at, created_at, updated_at FROM kb_documents ORDER BY updated_at DESC`)
  })

  app.post('/api/kb/documents/upload', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const file = await (req as any).file()
    if (!file) throw badRequest('Envie um arquivo.')
    const buf: Buffer = await file.toBuffer()
    const title = (file.fields?.title?.value as string | undefined)?.trim() || file.filename.replace(/\.[^.]+$/, '')
    let text: string
    try {
      text = await extractText(buf, file.mimetype, file.filename)
    } catch (err: any) {
      throw badRequest(`Não foi possível ler o arquivo: ${err?.message ?? err}`)
    }
    if (text.trim().length < 20) throw badRequest('O arquivo não tem texto legível (PDF escaneado? Envie a versão com texto).')
    const d = await one<any>(
      `INSERT INTO kb_documents(title, source, mime, filename, raw_text, created_by) VALUES ($1,'upload',$2,$3,$4,$5) RETURNING id`,
      [title, file.mimetype, file.filename, text, me.id],
    )
    await enqueue('kb.index', { documentId: d.id }, { singletonKey: `kb:${d.id}`, mode: 'keep' })
    await audit({ userId: me.id, action: 'kb.document_added', entity: 'kb_document', entityId: d.id, data: { title, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) }, ip: clientIp(req) })
    return d
  })

  app.post('/api/kb/documents', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const b = z
      .object({ title: z.string().min(2).max(160), text: z.string().max(400_000).optional(), url: z.string().url().optional(), refreshDays: z.number().int().min(1).max(90).nullable().optional() })
      .parse(req.body)
    if (!b.text && !b.url) throw badRequest('Informe o texto ou o endereço do site.')
    const d = await one<any>(
      `INSERT INTO kb_documents(title, source, url, raw_text, refresh_days, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.title, b.url ? 'site' : 'text', b.url ?? null, b.text ?? null, b.refreshDays ?? null, me.id],
    )
    await enqueue('kb.index', { documentId: d.id }, { singletonKey: `kb:${d.id}`, mode: 'keep' })
    await audit({ userId: me.id, action: 'kb.document_added', entity: 'kb_document', entityId: d.id, data: { title: b.title, url: b.url }, ip: clientIp(req) })
    return d
  })

  app.get('/api/kb/documents/:id', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const d = await one(`SELECT * FROM kb_documents WHERE id=$1`, [id])
    if (!d) throw notFound()
    const chunks = await q(`SELECT idx, heading, left(content, 400) AS preview, length(content) AS size, embedding_model FROM kb_chunks WHERE document_id=$1 ORDER BY idx LIMIT 400`, [id])
    return { ...d, chunks_list: chunks }
  })

  app.patch('/api/kb/documents/:id', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ title: z.string().min(2).max(160).optional(), active: z.boolean().optional(), text: z.string().max(400_000).optional(), refreshDays: z.number().int().nullable().optional() }).parse(req.body)
    await q(
      `UPDATE kb_documents SET title=coalesce($2,title), active=coalesce($3,active), raw_text=coalesce($4,raw_text),
              refresh_days = CASE WHEN $5::boolean THEN $6 ELSE refresh_days END, updated_at=now() WHERE id=$1`,
      [id, b.title ?? null, b.active ?? null, b.text ?? null, b.refreshDays !== undefined, b.refreshDays ?? null],
    )
    if (b.text !== undefined) await enqueue('kb.index', { documentId: id }, { singletonKey: `kb:${id}`, mode: 'keep' })
    await audit({ userId: me.id, action: 'kb.document_updated', entity: 'kb_document', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/kb/documents/:id/reindex', async (req) => {
    requirePermission(req, 'kbEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await enqueue('kb.index', { documentId: id }, { singletonKey: `kb:${id}`, mode: 'keep' })
    return { ok: true }
  })

  app.delete('/api/kb/documents/:id', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM kb_documents WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'kb.document_deleted', entity: 'kb_document', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.get('/api/kb/faq', async (req) => {
    currentUser(req)
    return q(`SELECT id, question, answer, keywords, active, updated_at FROM faq_entries ORDER BY updated_at DESC`)
  })
  const faqBody = z.object({ question: z.string().min(3).max(400), answer: z.string().min(2).max(4000), keywords: z.string().max(400).default(''), active: z.boolean().default(true) })
  app.post('/api/kb/faq', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const b = faqBody.parse(req.body)
    const r = await one(`INSERT INTO faq_entries(question, answer, keywords, active, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.question, b.answer, b.keywords, b.active, me.id])
    await audit({ userId: me.id, action: 'kb.faq_added', entity: 'faq', entityId: r.id, ip: clientIp(req) })
    return r
  })
  app.put('/api/kb/faq/:id', async (req) => {
    const me = requirePermission(req, 'kbEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = faqBody.parse(req.body)
    await q(`UPDATE faq_entries SET question=$2, answer=$3, keywords=$4, active=$5, updated_at=now() WHERE id=$1`, [id, b.question, b.answer, b.keywords, b.active])
    await audit({ userId: me.id, action: 'kb.faq_updated', entity: 'faq', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })
  app.delete('/api/kb/faq/:id', async (req) => {
    requirePermission(req, 'kbEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM faq_entries WHERE id=$1`, [id])
    return { ok: true }
  })

  /** "Testar a base": mostra o que a IA receberia como contexto para uma pergunta. */
  app.post('/api/kb/search', async (req) => {
    currentUser(req)
    const { query } = z.object({ query: z.string().min(2).max(500) }).parse(req.body)
    const hits = await searchKb(query, 6)
    return { hits, context: formatKbContext(hits) }
  })

  // ============================================================ critérios de qualificação
  app.get('/api/ai/criteria', async (req) => {
    currentUser(req)
    return q(`SELECT * FROM qualification_criteria ORDER BY sort, label`)
  })
  const critBody = z.object({
    key: z.string().min(2).max(40).regex(/^[a-z][a-z0-9_]*$/, 'use letras minúsculas, números e _'),
    label: z.string().min(2).max(80),
    question: z.string().min(3).max(300),
    description: z.string().max(600).default(''),
    type: z.enum(['choice', 'number', 'boolean', 'text']),
    options: z.any(),
    weight: z.number().min(0).max(10).default(1),
    required: z.boolean().default(true),
    disqualifyValues: z.array(z.any()).default([]),
    sort: z.number().int().default(0),
    active: z.boolean().default(true),
  })
  app.post('/api/ai/criteria', async (req) => {
    const me = requireRole(req, 'admin', 'supervisor')
    const b = critBody.parse(req.body)
    const r = await one(
      `INSERT INTO qualification_criteria(key,label,question,description,type,options,weight,required,disqualify_values,sort,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.key, b.label, b.question, b.description, b.type, JSON.stringify(b.options ?? []), b.weight, b.required, JSON.stringify(b.disqualifyValues), b.sort, b.active],
    )
    await audit({ userId: me.id, action: 'ai.criterion_created', entity: 'criterion', entityId: r.id, data: { key: b.key }, ip: clientIp(req) })
    return r
  })
  app.put('/api/ai/criteria/:id', async (req) => {
    const me = requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = critBody.parse(req.body)
    await q(
      `UPDATE qualification_criteria SET key=$2,label=$3,question=$4,description=$5,type=$6,options=$7,weight=$8,required=$9,disqualify_values=$10,sort=$11,active=$12 WHERE id=$1`,
      [id, b.key, b.label, b.question, b.description, b.type, JSON.stringify(b.options ?? []), b.weight, b.required, JSON.stringify(b.disqualifyValues), b.sort, b.active],
    )
    await audit({ userId: me.id, action: 'ai.criterion_updated', entity: 'criterion', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })
  app.delete('/api/ai/criteria/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM qualification_criteria WHERE id=$1`, [id])
    return { ok: true }
  })
  /** Simula o score para um perfil (usado no painel para calibrar pesos e corte). */
  app.post('/api/ai/criteria/simulate', async (req) => {
    currentUser(req)
    const { profile } = z.object({ profile: z.record(z.string(), z.any()) }).parse(req.body)
    const r = computeScore(await activeCriteria(), profile)
    return { total: r.total, lines: r.lines, missing: r.missing.map((m) => m.key), disqualifiedBy: r.disqualifiedBy }
  })

  // ============================================================ compliance
  app.post('/api/ai/compliance/check', async (req) => {
    currentUser(req)
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body)
    const r = await checkCompliance(text, null)
    return { ...r, label: r.rule ? RULE_LABEL[r.rule] : null }
  })

  // ============================================================ apoio ao atendente
  app.post('/api/conversations/:id/suggest', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    try {
      return await suggestReply(id)
    } catch (err: any) {
      throw badRequest(`Não foi possível gerar sugestão: ${err?.message ?? err}`)
    }
  })

  app.post('/api/conversations/:id/handoff-card', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const conv = await one<any>(`SELECT handoff_reason FROM conversations WHERE id=$1`, [id])
    if (!conv) throw notFound()
    await buildHandoffCard(id, conv.handoff_reason ?? 'Resumo solicitado pelo atendente')
    return { ok: true }
  })
}
