/**
 * Agente de IA: um "turno" de atendimento automático.
 *
 *  triagem (rápida) → gatilhos de transferência → base de conhecimento → agente com ferramentas
 *  (registrar critérios, transferir, consultas) → score determinístico → guarda de compliance
 *  → aviso de risco → envio com ritmo humano.
 */
import { one, q } from '../lib/db.js'
import { enqueue, work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { audit } from '../ops/audit.js'
import { getSetting } from '../ops/settings.js'
import { logEvent, transfer, type ConversationRow } from '../inbox/service.js'
import { sendText } from '../inbox/outbound.js'
import { emitConversation } from '../http/realtime.js'
import { checkCompliance, RULE_LABEL, withDisclaimer } from './guard.js'
import { formatKbContext, searchKb } from './kb.js'
import { parseJsonLoose, type ChatMessage, type ToolDef } from './providers.js'
import { activeCriteria, applyCriteria, applyCriteriaInMemory, criteriaToolSchema } from './qualification.js'
import { AiUnavailable, runChat } from './router.js'

// ---------------------------------------------------------------- extensões (ferramentas extras)

export interface AgentToolContext {
  conversation: ConversationRow
  contact: any
  agent: any
}
export interface AgentToolSet {
  tools: ToolDef[]
  handle: (name: string, args: any) => Promise<any | undefined>
}
const toolProviders: ((ctx: AgentToolContext) => Promise<AgentToolSet>)[] = []
export function registerAgentTools(fn: (ctx: AgentToolContext) => Promise<AgentToolSet>) {
  toolProviders.push(fn)
}

// ---------------------------------------------------------------- tipos

export type AgentOutcome =
  | { kind: 'replied'; text: string }
  | { kind: 'handoff'; reason: string; sectorId: string | null; priority: number; text?: string }
  | { kind: 'qualified'; score: number; sectorId: string | null; text?: string }
  | { kind: 'disqualified'; reason: string; text?: string }
  | { kind: 'opt_out' }
  | { kind: 'error'; reason: string }

export interface TurnOptions {
  agentId?: string | null
  /** true: o próprio agente executa a transferência (sem fluxo). false: devolve o resultado ao fluxo. */
  executeOutcome: boolean
  /** objetivo extra vindo do nó de fluxo */
  extraInstructions?: string
  /** simulador: não envia ao WhatsApp, apenas retorna */
  dryRun?: { history: ChatMessage[]; contact: any; send: (text: string) => Promise<void> }
}

interface Triage {
  intent?: string
  wants_human?: boolean
  sensitive?: boolean
  sensitive_topic?: string | null
  frustration?: boolean
  existing_customer_account_issue?: boolean
  opt_out?: boolean
}

const TRIAGE_SYSTEM = `Você classifica a ÚLTIMA mensagem de um contato que fala com o WhatsApp da Nimber (plataforma de investimento em imóveis tokenizados).
Responda SOMENTE com JSON:
{"intent": "duvida|interesse_investir|suporte_cliente|falar_com_humano|assunto_sensivel|saudacao|conversa|outro",
 "wants_human": boolean,            // pede explicitamente para falar com uma pessoa/atendente/especialista
 "sensitive": boolean,              // resgate, saque, problema com investimento, reclamação, Procon, advogado, processo, fraude
 "sensitive_topic": string|null,
 "frustration": boolean,            // irritação, xingamento, reclamação de demora, frustração clara
 "existing_customer_account_issue": boolean, // já é investidor e o assunto é a conta dele (acesso, extrato, rendimentos, tokens)
 "opt_out": boolean}                // pede para não receber mais mensagens ("parar", "sair", "não quero mais")`

// ---------------------------------------------------------------- utilidades

async function sectorBySlug(slug?: string | null) {
  if (!slug) return null
  return one<any>(`SELECT id, name FROM sectors WHERE slug=$1 AND active`, [slug])
}

async function loadHistory(conversationId: string, limit: number): Promise<ChatMessage[]> {
  const rows = await q<any>(
    `SELECT direction, sender_type, kind, body, transcript FROM messages
      WHERE conversation_id=$1 AND direction <> 'internal' AND status <> 'blocked'
      ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit],
  )
  const msgs: ChatMessage[] = []
  for (const r of rows.reverse()) {
    const text =
      r.kind === 'audio'
        ? r.transcript
          ? `[áudio transcrito] ${r.transcript}`
          : '[áudio sem transcrição]'
        : r.kind === 'text'
          ? r.body
          : `[${r.kind}${r.body ? `: ${r.body}` : ''}]`
    if (!text) continue
    const role: 'user' | 'assistant' = r.direction === 'in' ? 'user' : 'assistant'
    // junta mensagens consecutivas do mesmo lado (exigência de alguns provedores)
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content += `\n${text}`
    else msgs.push({ role, content: text })
  }
  // A conversa precisa começar com o usuário
  while (msgs.length && msgs[0]!.role === 'assistant') msgs.shift()
  return msgs
}

function lastUserText(history: ChatMessage[]) {
  return [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
}

export async function defaultAgent() {
  return one<any>(`SELECT * FROM ai_agents WHERE active ORDER BY is_default DESC, created_at LIMIT 1`)
}

function buildSystemPrompt(agent: any, ctx: { contact: any; sectors: any[]; pending: any[]; kb: string; extra?: string; profileLines: string[] }) {
  const today = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date())
  return `${agent.persona}

# Objetivo
${agent.objective}
${ctx.extra ? `\n# Objetivo desta etapa\n${ctx.extra}\n` : ''}
# Instruções
${agent.instructions}

# Regras de compliance (inegociáveis)
- NUNCA prometa, garanta ou projete rentabilidade, retorno ou valorização. Se perguntarem, informe apenas números oficialmente publicados na oferta que estejam no CONHECIMENTO, sempre como estimativa e lembrando que rentabilidade passada ou projetada não garante resultado futuro.
- NUNCA diga que um investimento é "sem risco" ou "garantido".
- NUNCA faça recomendação personalizada ("para o seu perfil, invista em X", "coloque Y reais"). Explique como funciona e ofereça um especialista.
- NUNCA dê orientação jurídica ou tributária (impostos, declaração, direitos). Diga que um especialista pode orientar e transfira se a pessoa insistir.
- Nunca invente informações que não estejam no CONHECIMENTO. Se não souber, use a ferramenta transferir_para_humano com motivo "sem_resposta".
- Nunca peça senha, código de verificação ou dados bancários.

# Contato
Nome: ${ctx.contact?.name || ctx.contact?.push_name || 'desconhecido'}${ctx.contact?.is_customer ? ' (já é investidor da Nimber)' : ''}
${ctx.profileLines.length ? `Já sabemos: ${ctx.profileLines.join('; ')}` : 'Ainda não sabemos nada sobre o perfil de investimento.'}
${ctx.pending.length ? `Critérios ainda não respondidos (pergunte UM por vez, de forma natural, quando fizer sentido):\n${ctx.pending.map((c) => `- ${c.label}: ex. "${c.question}"`).join('\n')}` : 'Todos os critérios de qualificação já foram respondidos.'}

# Setores para transferência
${ctx.sectors.map((s) => `- ${s.slug}: ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n')}

# CONHECIMENTO (use apenas isto para responder sobre a Nimber e as ofertas)
${ctx.kb}

Data de hoje: ${today}.
Responda em português do Brasil, em mensagens curtas de WhatsApp, sem markdown de títulos ou tabelas (pode usar *negrito* com moderação).`
}

// ---------------------------------------------------------------- turno principal

export async function runAgentTurn(conv: ConversationRow, opts: TurnOptions): Promise<AgentOutcome> {
  const aiSettings = await getSetting('ai', { enabled: true, historyMessages: 24 })
  const handoffCfg = await getSetting('handoff', {
    explicitRequest: true,
    qualified: true,
    noAnswer: true,
    sensitive: true,
    frustration: true,
    failures: true,
    failureLimit: 2,
    existingCustomer: true,
    supportSectorSlug: 'suporte',
    legalSectorSlug: 'suporte',
  })
  const agent = opts.agentId ? await one<any>(`SELECT * FROM ai_agents WHERE id=$1`, [opts.agentId]) : await defaultAgent()
  if (!agent) return { kind: 'error', reason: 'Nenhum agente de IA configurado' }
  if (!aiSettings.enabled) return { kind: 'error', reason: 'IA desativada nas configurações' }

  const contact = opts.dryRun?.contact ?? (await one<any>(`SELECT * FROM contacts WHERE id=$1`, [conv.contact_id]))
  const history = opts.dryRun?.history ?? (await loadHistory(conv.id, aiSettings.historyMessages))
  const userText = lastUserText(history)
  const convId = opts.dryRun ? null : conv.id
  const aiState = { failures: 0, turns: 0, ...(conv.context?.ai ?? {}) }

  // 1) Triagem
  let triage: Triage = {}
  try {
    const t = await runChat('triage', { system: TRIAGE_SYSTEM, messages: [{ role: 'user', content: userText || '(sem texto)' }], json: true, timeoutMs: 15_000 }, convId)
    triage = parseJsonLoose<Triage>(t.text) ?? {}
  } catch (err) {
    if (err instanceof AiUnavailable) return { kind: 'error', reason: err.message }
  }

  if (triage.opt_out) return { kind: 'opt_out' }
  const support = await sectorBySlug(handoffCfg.supportSectorSlug)
  const legal = await sectorBySlug(handoffCfg.legalSectorSlug)
  if (handoffCfg.explicitRequest && triage.wants_human)
    return { kind: 'handoff', reason: 'Pediu para falar com uma pessoa', sectorId: null, priority: 1 }
  if (handoffCfg.sensitive && triage.sensitive)
    return { kind: 'handoff', reason: `Assunto sensível: ${triage.sensitive_topic ?? 'resgate/reclamação'}`, sectorId: legal?.id ?? support?.id ?? null, priority: 2 }
  if (handoffCfg.existingCustomer && triage.existing_customer_account_issue)
    return { kind: 'handoff', reason: 'Investidor com assunto da própria conta', sectorId: support?.id ?? null, priority: 1 }
  if (handoffCfg.frustration && triage.frustration) return { kind: 'handoff', reason: 'Contato demonstrou frustração', sectorId: null, priority: 2 }
  if (aiState.turns >= (agent.max_turns ?? 14)) return { kind: 'handoff', reason: 'Limite de interações automáticas atingido', sectorId: null, priority: 0 }

  // 2) Conhecimento
  const kbQuery = history
    .filter((m) => m.role === 'user')
    .slice(-2)
    .map((m) => m.content)
    .join('\n')
  const hits = agent.kb_enabled ? await searchKb(kbQuery, 5) : []

  // 3) Qualificação: critérios pendentes
  const criteria = agent.qualification_enabled ? await activeCriteria() : []
  const profile = contact?.lead_profile ?? {}
  const pending = criteria.filter((c) => profile[c.key] === undefined || profile[c.key] === null || profile[c.key] === '')
  const profileLines = (contact?.score_breakdown ?? []).map((l: any) => `${l.label}: ${l.display}`)
  const sectors = await q<any>(`SELECT slug, name, description, id FROM sectors WHERE active ORDER BY sort`)

  // 4) Ferramentas
  let handoff: { reason: string; sector: string | null } | null = null
  let qual: Awaited<ReturnType<typeof applyCriteria>> | null = null
  const tools: ToolDef[] = [
    {
      name: 'transferir_para_humano',
      description:
        'Transfere a conversa para um atendente humano. Use quando: o contato pedir; você não tiver a resposta no CONHECIMENTO (motivo "sem_resposta"); o assunto exigir especialista (jurídico, tributário, recomendação); ou a pessoa quiser investir/falar de valores concretos.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo curto, ex.: "sem_resposta: pergunta sobre prazo de resgate do Hive SP"' },
          setor: { type: 'string', enum: sectors.map((s) => s.slug), description: 'Setor de destino' },
        },
        required: ['motivo'],
      },
    },
  ]
  if (criteria.length) {
    tools.push({
      name: 'registrar_criterios',
      description: 'Registra respostas do contato aos critérios de qualificação assim que ele informar algo. Retorna o score atual e a próxima pergunta sugerida.',
      parameters: criteriaToolSchema(criteria),
    })
  }
  const extraSets = await Promise.all(toolProviders.map((p) => p({ conversation: conv, contact, agent }).catch(() => ({ tools: [], handle: async () => undefined }))))
  for (const s of extraSets) tools.push(...s.tools)

  const onTool = async (name: string, args: any) => {
    if (name === 'transferir_para_humano') {
      handoff = { reason: String(args?.motivo ?? 'Transferência solicitada pela IA'), sector: args?.setor ?? null }
      return { ok: true, instrucao: 'Escreva uma mensagem curta avisando que um especialista vai continuar o atendimento.' }
    }
    if (name === 'registrar_criterios') {
      if (opts.dryRun) qual = await applyCriteriaInMemory(contact, args?.valores ?? {})
      else if (contact?.id) qual = await applyCriteria(contact.id, args?.valores ?? {})
      else return { ok: false }
      return {
        score: qual.score,
        qualificado: qual.qualified,
        desqualificado: qual.disqualified,
        proxima_pergunta: qual.qualified ? null : (qual.next?.question ?? null),
        instrucao: qual.qualified
          ? 'O lead está qualificado: diga que vai conectar com um especialista do time comercial.'
          : qual.next
            ? 'Continue a conversa e, quando natural, faça a próxima pergunta.'
            : 'Critérios completos.',
      }
    }
    for (const s of extraSets) {
      const r = await s.handle(name, args)
      if (r !== undefined) return r
    }
    return { erro: `ferramenta desconhecida: ${name}` }
  }

  // 5) Agente
  let draft = ''
  try {
    const r = await runChat(
      'agent',
      {
        system: buildSystemPrompt(agent, { contact, sectors, pending, kb: formatKbContext(hits), extra: opts.extraInstructions, profileLines }),
        messages: history.length ? history : [{ role: 'user', content: '(início da conversa)' }],
        tools,
        onTool,
        maxToolRounds: 4,
        timeoutMs: 60_000,
      },
      convId,
    )
    draft = r.text.trim()
  } catch (err) {
    return { kind: 'error', reason: (err as Error).message }
  }

  // 6) Resultado da qualificação (determinístico)
  const qr = qual as Awaited<ReturnType<typeof applyCriteria>> | null
  const sectorFor = (slug?: string | null) => sectors.find((s) => s.slug === slug)?.id ?? null

  if (!draft && !handoff && !qr) {
    aiState.failures++
    if (!opts.dryRun) await q(`UPDATE conversations SET context = jsonb_set(context, '{ai}', $2::jsonb) WHERE id=$1`, [conv.id, JSON.stringify(aiState)])
    if (handoffCfg.failures && aiState.failures >= handoffCfg.failureLimit) return { kind: 'handoff', reason: 'A IA não conseguiu responder', sectorId: null, priority: 1 }
    return { kind: 'error', reason: 'Resposta vazia da IA' }
  }

  // 7) Compliance
  if (draft) {
    const g = await checkCompliance(draft, convId)
    if (!g.ok) {
      if (!opts.dryRun) {
        await q(
          `INSERT INTO messages(conversation_id, connection_id, direction, sender_type, kind, body, status, meta)
           VALUES ($1,$2,'out','ai','text',$3,'blocked',$4)`,
          [conv.id, conv.connection_id, draft, JSON.stringify({ rule: g.rule, by: g.by, excerpt: g.excerpt })],
        )
        await logEvent(conv.id, 'compliance.blocked', { type: 'ai' }, { rule: RULE_LABEL[g.rule!], by: g.by })
        await audit({ action: 'compliance.blocked', entity: 'conversation', entityId: conv.id, data: { rule: g.rule, by: g.by, excerpt: g.excerpt } })
        void import('../ops/notifications.js').then((n) => n.notifyTeam(`compliance:${conv.id}`, `o compliance bloqueou uma resposta da IA (${RULE_LABEL[g.rule!]}). Conversa transferida para humano.`, 'compliance'))
        void import('../integrations/webhooks.js').then((w) => w.fireEvent('compliance.blocked', { conversationId: conv.id, rule: g.rule }))
      }
      return { kind: 'handoff', reason: `Compliance: a IA tentou responder com ${RULE_LABEL[g.rule!]}`, sectorId: null, priority: 2, text: 'Essa é uma ótima pergunta. Para te responder com precisão, vou chamar um especialista do nosso time, tudo bem? Ele continua por aqui em instantes.' }
    }
    const recent = opts.dryRun
      ? false
      : !!(await one(
          `SELECT 1 FROM messages WHERE conversation_id=$1 AND sender_type='ai' AND body LIKE '%' || left($2, 60) || '%' AND created_at > now() - interval '6 hours'`,
          [conv.id, (await getSetting('compliance', { disclaimer: '' })).disclaimer || '___'],
        ))
    draft = await withDisclaimer(draft, recent)
  }

  aiState.turns++
  aiState.failures = 0
  if (!opts.dryRun) await q(`UPDATE conversations SET context = jsonb_set(context, '{ai}', $2::jsonb) WHERE id=$1`, [conv.id, JSON.stringify(aiState)])

  const h = handoff as { reason: string; sector: string | null } | null
  if (qr?.qualified && handoffCfg.qualified)
    return { kind: 'qualified', score: qr.score, sectorId: sectorFor(qr.targetSectorSlug), text: draft || 'Perfeito! Vou te conectar com um especialista do nosso time comercial.' }
  if (qr?.disqualified) return { kind: 'disqualified', reason: qr.disqualifiedBy ?? `Score ${qr.score} abaixo do mínimo`, text: draft }
  if (h) {
    const noAnswer = h.reason.startsWith('sem_resposta')
    if (noAnswer && !handoffCfg.noAnswer) return { kind: 'replied', text: draft }
    return { kind: 'handoff', reason: noAnswer ? `Sem resposta na base: ${h.reason.replace(/^sem_resposta:?\s*/, '')}` : h.reason, sectorId: sectorFor(h.sector), priority: 0, text: draft }
  }
  return { kind: 'replied', text: draft }
}

// ---------------------------------------------------------------- execução fora de fluxo

/** Executa o resultado de um turno quando o agente atende diretamente (sem fluxo). */
export async function applyOutcome(conv: ConversationRow, outcome: AgentOutcome) {
  const say = async (text?: string) => {
    if (text) await sendText(conv.id, text, { senderType: 'ai' })
  }
  switch (outcome.kind) {
    case 'replied':
      await say(outcome.text)
      return
    case 'opt_out':
      await q(`UPDATE contacts SET opted_out=true WHERE id=$1`, [conv.contact_id])
      await sendText(conv.id, 'Tudo bem! Você não receberá mais mensagens automáticas. Se precisar, é só escrever por aqui.', { senderType: 'ai' })
      await logEvent(conv.id, 'contact.opted_out', { type: 'ai' })
      await (await import('../inbox/service.js')).closeConversation(conv.id, { type: 'ai' }, 'Contato pediu para não receber mensagens')
      return
    case 'qualified': {
      await say(outcome.text)
      await logEvent(conv.id, 'lead.qualified', { type: 'ai' }, { score: outcome.score })
      void import('../integrations/webhooks.js').then((w) => w.fireEvent('lead.qualified', { conversationId: conv.id, contactId: conv.contact_id, score: outcome.score })).catch(() => {})
      await handoffNow(conv, outcome.sectorId, `Lead qualificado (score ${outcome.score})`, 2)
      return
    }
    case 'disqualified':
      await say(outcome.text)
      await logEvent(conv.id, 'lead.disqualified', { type: 'ai' }, { reason: outcome.reason })
      return
    case 'handoff':
      await say(outcome.text ?? 'Vou chamar um especialista do nosso time para continuar o seu atendimento. Só um instante!')
      await handoffNow(conv, outcome.sectorId, outcome.reason, outcome.priority)
      return
    case 'error':
      log().warn({ conversationId: conv.id, reason: outcome.reason }, 'IA não respondeu — transferindo para humano')
      await handoffNow(conv, null, `IA indisponível: ${outcome.reason}`, 1)
  }
}

export async function handoffNow(conv: ConversationRow, sectorId: string | null, reason: string, priority = 0) {
  await logEvent(conv.id, 'ai.handoff', { type: 'ai' }, { reason })
  const conn = await one<any>(`SELECT default_sector_id FROM connections WHERE id=$1`, [conv.connection_id])
  await transfer(conv.id, { sectorId: sectorId ?? conv.sector_id ?? conn?.default_sector_id }, { type: 'ai', name: 'Assistente IA' }, reason, { priority })
  await enqueue('ai.handoff_card', { conversationId: conv.id, reason }, { singletonKey: `card:${conv.id}`, mode: 'replace', maxAttempts: 2 })
}

// ---------------------------------------------------------------- cartão de contexto (resumo para o humano)

const SUMMARY_SYSTEM = `Você prepara um cartão de contexto para o atendente humano que vai assumir uma conversa de WhatsApp da Nimber (investimentos em imóveis tokenizados).
Responda SOMENTE com JSON:
{"resumo": "2 a 3 frases: quem é, o que quer, em que ponto parou",
 "interesse": "produto/assunto principal",
 "pontos_de_atencao": ["até 3 itens: objeções, urgência, sensibilidades"],
 "sugestao_resposta": "primeira mensagem sugerida para o atendente enviar, cordial e objetiva, sem promessas de rentabilidade"}`

export async function buildHandoffCard(conversationId: string, reason: string) {
  const conv = await one<any>(`SELECT * FROM conversations WHERE id=$1`, [conversationId])
  if (!conv) return
  const contact = await one<any>(`SELECT name, push_name, score, score_breakdown, lead_status, is_customer FROM contacts WHERE id=$1`, [conv.contact_id])
  const history = await loadHistory(conversationId, 30)
  let card: any = null
  try {
    const transcript = history.map((m) => `${m.role === 'user' ? 'Contato' : 'Nimber'}: ${m.content}`).join('\n')
    const r = await runChat('summary', { system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: `Motivo da transferência: ${reason}\n\nConversa:\n${transcript}` }], json: true, timeoutMs: 30_000 }, conversationId)
    card = parseJsonLoose(r.text)
  } catch {
    /* sem resumo: o cartão mostra só score e motivo */
  }
  const value = {
    reason,
    summary: card?.resumo ?? null,
    interest: card?.interesse ?? null,
    attention: Array.isArray(card?.pontos_de_atencao) ? card.pontos_de_atencao.slice(0, 3) : [],
    suggestedReply: card?.sugestao_resposta ?? null,
    score: contact?.score ?? null,
    breakdown: contact?.score_breakdown ?? [],
    leadStatus: contact?.lead_status,
    generatedAt: new Date().toISOString(),
  }
  const updated = await one<any>(`UPDATE conversations SET handoff_card=$2 WHERE id=$1 RETURNING id, sector_id, assignee_id`, [conversationId, JSON.stringify(value)])
  if (updated) {
    const { broadcastConversation } = await import('../inbox/service.js')
    await broadcastConversation(conversationId)
    emitConversation(updated, 'conversation:card', { conversationId, card: value })
  }
}

/** Sugestão de resposta para o atendente (botão "Sugerir resposta"), já passando pela guarda de compliance. */
export async function suggestReply(conversationId: string): Promise<{ text: string; blocked?: string }> {
  const history = await loadHistory(conversationId, 20)
  const hits = await searchKb(lastUserText(history), 4)
  const r = await runChat(
    'summary',
    {
      system: `Você ajuda um atendente humano da Nimber (investimentos em imóveis tokenizados) a responder no WhatsApp. Escreva APENAS a próxima mensagem do atendente, em português, curta e cordial, usando somente informações do CONHECIMENTO. Nunca prometa rentabilidade, não faça recomendação personalizada nem dê orientação jurídica/tributária.\n\n${formatKbContext(hits)}`,
      messages: history.length ? history : [{ role: 'user', content: 'Olá' }],
      timeoutMs: 30_000,
      mockHint: 'agent',
    },
    conversationId,
  )
  const text = r.text.trim()
  const g = await checkCompliance(text, conversationId)
  if (!g.ok) return { text: '', blocked: RULE_LABEL[g.rule!] }
  return { text }
}

// ---------------------------------------------------------------- workers e automação padrão

export function registerAgentWorkers() {
  work('ai.handoff_card', async (job: Job<{ conversationId: string; reason: string }>) => buildHandoffCard(job.payload.conversationId, job.payload.reason), 2)
}
