/**
 * Execução persistida de fluxos nas conversas reais.
 */
import { one, q } from '../lib/db.js'
import { enqueue, work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { registerAutomation } from '../inbox/automation.js'
import { closeConversation, getConversation, isSectorOpen, logEvent, transfer, type ConversationRow } from '../inbox/service.js'
import { sendText } from '../inbox/outbound.js'
import { applyOutcome, runAgentTurn, defaultAgent } from '../ai/agent.js'
import { parseJsonLoose } from '../ai/providers.js'
import { runChat } from '../ai/router.js'
import { getSetting } from '../ops/settings.js'
import { execute } from './engine.js'
import type { FlowDefinition, FlowIO, RunState } from './types.js'
import { moduleOn } from '../platform/modules.js'

async function loadHistory(conversationId: string) {
  const rows = await q<any>(
    `SELECT direction, kind, body, transcript FROM messages WHERE conversation_id=$1 AND direction <> 'internal' AND status <> 'blocked' ORDER BY created_at DESC LIMIT 30`,
    [conversationId],
  )
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const r of rows.reverse()) {
    const text = r.kind === 'audio' ? r.transcript ?? '[áudio]' : r.body ?? `[${r.kind}]`
    const role: 'user' | 'assistant' = r.direction === 'in' ? 'user' : 'assistant'
    const last = out[out.length - 1]
    if (last && last.role === role) last.content += `\n${text}`
    else out.push({ role, content: text })
  }
  return out
}

export function realIO(conv: ConversationRow, runId: string): FlowIO {
  return {
    sim: false,
    contact: () => one(`SELECT * FROM contacts WHERE id=$1`, [conv.contact_id]),
    send: async (text) => {
      if (text.trim()) await sendText(conv.id, text, { senderType: 'flow' })
    },
    transfer: async (sectorId, userId, reason, priority) => {
      const fallback = sectorId ?? conv.sector_id ?? (await one<any>(`SELECT default_sector_id FROM connections WHERE id=$1`, [conv.connection_id]))?.default_sector_id
      await transfer(conv.id, { sectorId: fallback, userId }, { type: 'flow', name: 'Fluxo' }, reason, { priority })
      await enqueue('ai.handoff_card', { conversationId: conv.id, reason }, { singletonKey: `card:${conv.id}`, mode: 'replace', maxAttempts: 2 })
    },
    close: async (reason) => {
      await closeConversation(conv.id, { type: 'flow' }, reason)
    },
    addTags: async (tagIds) => {
      for (const t of tagIds) await q(`INSERT INTO contact_tags VALUES ($1,$2) ON CONFLICT DO NOTHING`, [conv.contact_id, t])
    },
    updateContact: async (p) => {
      await q(
        `UPDATE contacts SET name=coalesce(nullif($2,''),name), email=coalesce(nullif($3,''),email), origin=coalesce(nullif($4,''),origin),
                lead_status=coalesce(nullif($5,''),lead_status), custom = custom || coalesce($6::jsonb,'{}'::jsonb), updated_at=now() WHERE id=$1`,
        [conv.contact_id, p.name ?? null, p.email ?? null, p.origin ?? null, p.leadStatus ?? null, p.custom ? JSON.stringify(p.custom) : null],
      )
    },
    agentTurn: async (agentId, extra) => {
      const fresh = (await getConversation(conv.id)) ?? conv
      return runAgentTurn(fresh, { agentId, executeOutcome: false, extraInstructions: extra })
    },
    aiJson: async (system, user, hint) => {
      const r = await runChat('triage', { system, messages: [{ role: 'user', content: user || '(vazio)' }], json: true, mockHint: hint, timeoutMs: 20_000 }, conv.id)
      return parseJsonLoose(r.text)
    },
    isSectorOpen: async (sectorId) => {
      const s = await one<any>(`SELECT * FROM sectors WHERE id=$1`, [sectorId])
      return s ? isSectorOpen(s) : true
    },
    scheduleTimer: async (ms, token) => {
      await enqueue('flow.timer', { runId, token }, { delayMs: ms, groupKey: `conv:${conv.id}`, maxAttempts: 2 })
    },
    runQuery: async (queryId, params) => {
      const { executeSavedQuery } = await import('../integrations/queries.js')
      return executeSavedQuery(queryId, params, { conversationId: conv.id, actor: 'flow' })
    },
    event: async (type, data) => {
      await logEvent(conv.id, type, { type: 'flow' }, data)
    },
    history: () => loadHistory(conv.id),
  }
}

async function persist(runId: string, versionId: string, res: Awaited<ReturnType<typeof execute>>) {
  const final = res.status === 'waiting' ? null : res.status
  await q(
    `UPDATE flow_runs SET status=$2, current_node_id=$3, waiting_for=$4, waiting_since = CASE WHEN $2='waiting' THEN now() ELSE NULL END,
            vars=$5, retries=$6, wake_token=$7, error=$8, ended_at = CASE WHEN $9::text IS NULL THEN NULL ELSE now() END
      WHERE id=$1`,
    [runId, res.status, res.state.currentNodeId, res.state.waitingFor, JSON.stringify(res.state.vars), res.state.retries, res.state.wakeToken, res.error ?? null, final],
  )
  for (const s of res.steps) {
    await q(`INSERT INTO flow_run_steps(run_id, flow_version_id, node_id, node_type, handle_out) VALUES ($1,$2,$3,$4,$5)`, [runId, versionId, s.nodeId, s.type, s.handle])
  }
}

async function finish(conv: ConversationRow, run: any, res: Awaited<ReturnType<typeof execute>>) {
  const flow = await one<any>(`SELECT name FROM flows WHERE id=$1`, [run.flow_id])
  if (res.status === 'failed') {
    log().error({ runId: run.id, error: res.error }, 'Fluxo falhou')
    await logEvent(conv.id, 'flow.failed', { type: 'flow' }, { flow: flow?.name, error: res.error })
    const fresh = await getConversation(conv.id)
    if (fresh?.status === 'automation') await transfer(conv.id, { sectorId: fresh.sector_id }, { type: 'flow' }, `Falha no fluxo "${flow?.name}": ${res.error}`)
    return
  }
  if (res.status === 'done') {
    await logEvent(conv.id, 'flow.finished', { type: 'flow' }, { flow: flow?.name })
    // Sem transferência explícita: continua com o agente de IA padrão ou vai para o setor de entrada.
    const fresh = await getConversation(conv.id)
    if (fresh?.status !== 'automation') return
    const ai = await getSetting('ai', { enabled: true })
    if (ai.enabled && (await defaultAgent())) {
      const outcome = await runAgentTurn(fresh, { executeOutcome: true })
      const again = await getConversation(conv.id)
      if (again?.status === 'automation') await applyOutcome(again, outcome)
    } else {
      await transfer(conv.id, { sectorId: fresh.sector_id }, { type: 'flow' }, `Fim do fluxo "${flow?.name}"`)
    }
  }
}

/** Processa a conversa pelo fluxo de entrada da conexão. Retorna false se não houver fluxo aplicável. */
export async function processWithFlow(conv: ConversationRow, reason: string, timer?: { runId: string; token: string }): Promise<boolean> {
  let run = await one<any>(`SELECT * FROM flow_runs WHERE conversation_id=$1 AND status IN ('running','waiting')`, [conv.id])
  if (!run) {
    if (timer) return true
    // Fluxo já rodou nesta conversa (terminou ou transferiu): não reinicia.
    const previous = await one(`SELECT 1 FROM flow_runs WHERE conversation_id=$1`, [conv.id])
    if (previous) return false
    const conn = await one<any>(
      `SELECT f.id AS flow_id, f.name, f.published_version_id FROM connections c JOIN flows f ON f.id=c.entry_flow_id
        WHERE c.id=$1 AND f.published_version_id IS NOT NULL AND NOT f.archived`,
      [conv.connection_id],
    )
    if (!conn) return false
    run = await one<any>(
      `INSERT INTO flow_runs(flow_id, flow_version_id, conversation_id, status) VALUES ($1,$2,$3,'running') RETURNING *`,
      [conn.flow_id, conn.published_version_id, conv.id],
    )
    await logEvent(conv.id, 'flow.started', { type: 'flow' }, { flow: conn.name })
  }
  const version = await one<any>(`SELECT definition FROM flow_versions WHERE id=$1`, [run.flow_version_id])
  const def: FlowDefinition = version.definition
  const state: RunState = { vars: run.vars ?? {}, currentNodeId: run.current_node_id, waitingFor: run.waiting_for, retries: run.retries ?? 0, wakeToken: run.wake_token }

  let entry = { resumed: false, input: null as string | null, timer: false }
  if (timer) {
    if (run.id !== timer.runId || run.wake_token !== timer.token) return true // temporizador antigo
    entry = { resumed: true, input: null, timer: true }
  } else if (run.status === 'waiting') {
    if (run.waiting_for === 'timer') {
      // Mensagens durante uma espera: o nó decide (o "Aguardar" ignora; seguimos esperando)
      entry = { resumed: true, input: null, timer: false }
    } else {
      const msgs = await q<any>(
        `SELECT kind, body, transcript FROM messages WHERE conversation_id=$1 AND direction='in' AND created_at >= $2 ORDER BY created_at`,
        [conv.id, run.waiting_since],
      )
      if (!msgs.length) return true
      entry = { resumed: true, input: msgs.map((m) => (m.kind === 'audio' ? m.transcript ?? '' : m.body ?? '')).join('\n').trim(), timer: false }
    }
  }
  const res = await execute(def, state, realIO(conv, run.id), entry)
  await persist(run.id, run.flow_version_id, res)
  if (res.status !== 'waiting') await finish(conv, run, res)
  return true
}

export function registerFlowRuntime() {
  // Fluxo tem prioridade sobre o agente padrão
  // Fluxos só rodam com o módulo contratado
  registerAutomation('flow', (conv, reason) => (moduleOn('fluxos') ? processWithFlow(conv, reason) : Promise.resolve(false)), { first: true })
  work(
    'flow.timer',
    async (job: Job<{ runId: string; token: string }>) => {
      const run = await one<any>(`SELECT conversation_id FROM flow_runs WHERE id=$1`, [job.payload.runId])
      if (!run) return
      const conv = await getConversation(run.conversation_id)
      if (!conv || conv.status !== 'automation' || conv.ai_paused) return
      await processWithFlow(conv, 'timer', job.payload)
    },
    2,
  )
}

/** Cancela o fluxo ativo quando um humano assume (chamado por gancho de transferência). */
export async function cancelActiveRun(conversationId: string, why: string) {
  await q(`UPDATE flow_runs SET status='cancelled', ended_at=now(), error=$2 WHERE conversation_id=$1 AND status IN ('running','waiting')`, [conversationId, why])
}
