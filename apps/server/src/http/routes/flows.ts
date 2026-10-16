import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { effectivePermissions } from '../../auth/service.js'
import { one, q, tx } from '../../lib/db.js'
import { audit } from '../../ops/audit.js'
import { NODE_TYPES } from '../../flows/nodes.js'
import { simulate } from '../../flows/simulator.js'
import { TEMPLATES } from '../../flows/templates.js'
import type { FlowDefinition } from '../../flows/types.js'
import { validateFlow } from '../../flows/validate.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { clientIp, currentUser, requirePermission } from '../app.js'

const uuid = z.string().uuid()
const defSchema = z.object({
  nodes: z.array(z.object({ id: z.string().min(1).max(64), type: z.string().min(1).max(40), position: z.object({ x: z.number(), y: z.number() }).optional(), data: z.record(z.string(), z.any()).default({}) })).max(300),
  edges: z.array(z.object({ id: z.string().min(1).max(200), source: z.string(), sourceHandle: z.string().nullable().optional(), target: z.string() })).max(1000),
})

export async function flowRoutes(app: FastifyInstance) {
  app.get('/api/flows/node-types', async (req) => {
    currentUser(req)
    return NODE_TYPES.map(({ run: _run, defines: _d, dynamicOutputs, ...t }) => ({ ...t, dynamic: !!dynamicOutputs }))
  })

  app.get('/api/flows/templates', async (req) => {
    currentUser(req)
    return TEMPLATES.map(({ build: _b, ...t }) => t)
  })

  app.get('/api/flows', async (req) => {
    currentUser(req)
    return q(
      `SELECT f.id, f.name, f.description, f.archived, f.draft_updated_at, f.published_version_id, f.created_at,
              v.version AS published_version, v.published_at, u.name AS draft_updated_by_name,
              (SELECT coalesce(array_agg(c.name), '{}') FROM connections c WHERE c.entry_flow_id = f.id) AS connections,
              (SELECT count(*) FROM flow_runs r WHERE r.flow_id=f.id AND r.started_at > now() - interval '7 days') AS runs_7d,
              (SELECT count(*) FROM flow_runs r WHERE r.flow_id=f.id AND r.status IN ('running','waiting')) AS active_runs,
              (f.published_version_id IS NOT NULL AND v.definition::text <> f.draft::text) AS has_unpublished_changes
         FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id LEFT JOIN users u ON u.id=f.draft_updated_by
        WHERE NOT f.archived OR $1
        ORDER BY f.archived, f.name`,
      [(req.query as any)?.archived === '1'],
    )
  })

  app.post('/api/flows', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const b = z.object({ name: z.string().min(2).max(80), description: z.string().max(300).optional(), templateId: z.string().optional() }).parse(req.body)
    let draft: FlowDefinition = { nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }], edges: [] }
    if (b.templateId) {
      const t = TEMPLATES.find((x) => x.id === b.templateId)
      if (!t) throw badRequest('Modelo não encontrado.')
      const ids = Object.fromEntries((await q<any>(`SELECT slug, id FROM sectors`)).map((s) => [s.slug, s.id]))
      draft = t.build(ids)
    }
    const f = await one<any>(`INSERT INTO flows(name, description, draft, created_by, draft_updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id`, [
      b.name,
      b.description ?? null,
      JSON.stringify(draft),
      me.id,
    ])
    await audit({ userId: me.id, action: 'flow.created', entity: 'flow', entityId: f.id, data: { name: b.name, template: b.templateId }, ip: clientIp(req) })
    return f
  })

  app.get('/api/flows/:id', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const f = await one<any>(
      `SELECT f.*, v.version AS published_version, v.published_at, v.definition AS published_definition
         FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id WHERE f.id=$1`,
      [id],
    )
    if (!f) throw notFound()
    return f
  })

  app.put('/api/flows/:id/draft', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ draft: defSchema, name: z.string().min(2).max(80).optional(), description: z.string().max(300).nullable().optional() }).parse(req.body)
    const perms = effectivePermissions(me.role, me.permissions)
    if (!perms.flowsAdvanced) {
      // Quem não tem nós avançados não pode criar nem alterar nós avançados
      const current = await one<any>(`SELECT draft FROM flows WHERE id=$1`, [id])
      const advanced = new Set(NODE_TYPES.filter((t) => t.advanced).map((t) => t.type))
      const before = new Map<string, any>((current?.draft?.nodes ?? []).filter((n: any) => advanced.has(n.type)).map((n: any) => [n.id, JSON.stringify(n.data)]))
      for (const n of b.draft.nodes)
        if (advanced.has(n.type) && before.get(n.id) !== JSON.stringify(n.data)) throw forbidden('Você não tem permissão para editar nós avançados (código, HTTP).')
    }
    await q(
      `UPDATE flows SET draft=$2, draft_updated_at=now(), draft_updated_by=$3, name=coalesce($4,name), description=CASE WHEN $5::boolean THEN $6 ELSE description END WHERE id=$1`,
      [id, JSON.stringify(b.draft), me.id, b.name ?? null, b.description !== undefined, b.description ?? null],
    )
    return { ok: true, savedAt: new Date().toISOString() }
  })

  app.post('/api/flows/:id/validate', async (req) => {
    const me = currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const f = await one<any>(`SELECT draft FROM flows WHERE id=$1`, [id])
    if (!f) throw notFound()
    return validateFlow(f.draft, { allowAdvanced: effectivePermissions(me.role, me.permissions).flowsAdvanced })
  })

  app.post('/api/flows/:id/publish', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {})
    const f = await one<any>(`SELECT draft, name FROM flows WHERE id=$1`, [id])
    if (!f) throw notFound()
    const issues = validateFlow(f.draft, { allowAdvanced: effectivePermissions(me.role, me.permissions).flowsAdvanced })
    const errors = issues.filter((i) => i.level === 'error')
    if (errors.length) throw badRequest('Corrija os erros antes de publicar.', errors)
    const v = await tx(async (c) => {
      const next = await one<{ n: number }>(`SELECT coalesce(max(version),0)+1 AS n FROM flow_versions WHERE flow_id=$1`, [id], c)
      const row = await one<any>(
        `INSERT INTO flow_versions(flow_id, version, definition, note, published_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, version`,
        [id, next!.n, JSON.stringify(f.draft), note ?? null, me.id],
        c,
      )
      await c.query(`UPDATE flows SET published_version_id=$2 WHERE id=$1`, [id, row.id])
      return row
    })
    await audit({ userId: me.id, action: 'flow.published', entity: 'flow', entityId: id, data: { name: f.name, version: v.version, note }, ip: clientIp(req) })
    return { ...v, warnings: issues.filter((i) => i.level === 'warning') }
  })

  app.get('/api/flows/:id/versions', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    return q(
      `SELECT v.id, v.version, v.note, v.published_at, u.name AS published_by_name,
              (SELECT count(*) FROM flow_runs r WHERE r.flow_version_id=v.id) AS runs
         FROM flow_versions v LEFT JOIN users u ON u.id=v.published_by WHERE v.flow_id=$1 ORDER BY v.version DESC`,
      [id],
    )
  })

  /** Volta o rascunho (e opcionalmente a publicação) para uma versão anterior. */
  app.post('/api/flows/:id/versions/:versionId/restore', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id, versionId } = z.object({ id: uuid, versionId: uuid }).parse(req.params)
    const { publish } = z.object({ publish: z.boolean().default(false) }).parse(req.body ?? {})
    const v = await one<any>(`SELECT definition, version FROM flow_versions WHERE id=$1 AND flow_id=$2`, [versionId, id])
    if (!v) throw notFound()
    await q(`UPDATE flows SET draft=$2, draft_updated_at=now(), draft_updated_by=$3 WHERE id=$1`, [id, JSON.stringify(v.definition), me.id])
    if (publish) await q(`UPDATE flows SET published_version_id=$2 WHERE id=$1`, [id, versionId])
    await audit({ userId: me.id, action: publish ? 'flow.rolled_back' : 'flow.draft_restored', entity: 'flow', entityId: id, data: { version: v.version }, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/flows/:id/unpublish', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`UPDATE flows SET published_version_id=NULL WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'flow.unpublished', entity: 'flow', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/flows/:id/duplicate', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const f = await one<any>(`SELECT name, description, draft FROM flows WHERE id=$1`, [id])
    if (!f) throw notFound()
    return one(`INSERT INTO flows(name, description, draft, created_by, draft_updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING id`, [`${f.name} (cópia)`, f.description, JSON.stringify(f.draft), me.id])
  })

  app.post('/api/flows/:id/archive', async (req) => {
    const me = requirePermission(req, 'flowsEdit')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { archived } = z.object({ archived: z.boolean() }).parse(req.body)
    const used = await one<{ n: number }>(`SELECT count(*) AS n FROM connections WHERE entry_flow_id=$1`, [id])
    if (archived && (used?.n ?? 0) > 0) throw badRequest('Este fluxo é o fluxo de entrada de uma conexão. Troque o fluxo da conexão antes de arquivar.')
    await q(`UPDATE flows SET archived=$2 WHERE id=$1`, [id, archived])
    await audit({ userId: me.id, action: archived ? 'flow.archived' : 'flow.unarchived', entity: 'flow', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  /** Métricas por nó: quantas conversas passaram, por qual saída e onde pararam. */
  app.get('/api/flows/:id/metrics', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const qs = z.object({ days: z.coerce.number().min(1).max(180).default(30), versionId: uuid.optional() }).parse(req.query)
    const f = await one<any>(`SELECT published_version_id FROM flows WHERE id=$1`, [id])
    if (!f) throw notFound()
    const versionId = qs.versionId ?? f.published_version_id
    if (!versionId) return { nodes: {}, edges: {}, runs: { total: 0 } }
    const nodeRows = await q<any>(
      `SELECT s.node_id, count(DISTINCT s.run_id) AS entered
         FROM flow_run_steps s JOIN flow_runs r ON r.id=s.run_id
        WHERE s.flow_version_id=$1 AND r.started_at > now() - ($2 || ' days')::interval
        GROUP BY s.node_id`,
      [versionId, String(qs.days)],
    )
    const edgeRows = await q<any>(
      `SELECT s.node_id, s.handle_out, count(*) AS n
         FROM flow_run_steps s JOIN flow_runs r ON r.id=s.run_id
        WHERE s.flow_version_id=$1 AND s.handle_out IS NOT NULL AND r.started_at > now() - ($2 || ' days')::interval
        GROUP BY 1,2`,
      [versionId, String(qs.days)],
    )
    // "Parados": execuções aguardando no nó há mais de 1 hora ou que terminaram por abandono
    const stalled = await q<any>(
      `SELECT current_node_id AS node_id, count(*) AS n FROM flow_runs
        WHERE flow_version_id=$1 AND status='waiting' AND waiting_since < now() - interval '1 hour' GROUP BY 1`,
      [versionId],
    )
    const runs = await one<any>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status='transferred') AS transferred,
              count(*) FILTER (WHERE status='done') AS done,
              count(*) FILTER (WHERE status='closed') AS closed,
              count(*) FILTER (WHERE status IN ('running','waiting')) AS active,
              count(*) FILTER (WHERE status='failed') AS failed,
              count(*) FILTER (WHERE status='cancelled') AS cancelled
         FROM flow_runs WHERE flow_version_id=$1 AND started_at > now() - ($2 || ' days')::interval`,
      [versionId, String(qs.days)],
    )
    return {
      versionId,
      runs,
      nodes: Object.fromEntries(nodeRows.map((r) => [r.node_id, { entered: r.entered, stalled: stalled.find((s) => s.node_id === r.node_id)?.n ?? 0 }])),
      edges: Object.fromEntries(edgeRows.map((r) => [`${r.node_id}:${r.handle_out}`, r.n])),
    }
  })

  /** Simulador: conversa de teste com o rascunho (ou com a versão publicada). */
  app.post('/api/flows/:id/simulate', async (req) => {
    const me = currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z
      .object({ sessionId: z.string().optional(), type: z.enum(['start', 'message', 'timer']), text: z.string().max(2000).optional(), source: z.enum(['draft', 'published']).default('draft'), draft: defSchema.optional() })
      .parse(req.body)
    const f = await one<any>(`SELECT f.draft, v.definition AS published FROM flows f LEFT JOIN flow_versions v ON v.id=f.published_version_id WHERE f.id=$1`, [id])
    if (!f) throw notFound()
    const def: FlowDefinition = b.source === 'published' ? f.published : (b.draft ?? f.draft)
    if (!def) throw badRequest('Este fluxo ainda não tem versão publicada.')
    return simulate(me.id, def, { sessionId: b.sessionId, type: b.type, text: b.text })
  })
}
