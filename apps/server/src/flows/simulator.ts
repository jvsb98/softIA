/**
 * Simulador de fluxos: conversa de teste dentro do editor, sem enviar nada ao WhatsApp
 * e sem gravar no atendimento. Usa o mesmo motor do atendimento real.
 */
import { randomUUID } from 'node:crypto'
import { runAgentTurn } from '../ai/agent.js'
import { parseJsonLoose, type ChatMessage } from '../ai/providers.js'
import { runChat } from '../ai/router.js'
import { one } from '../lib/db.js'
import { isSectorOpen } from '../inbox/service.js'
import { execute } from './engine.js'
import type { FlowDefinition, FlowIO, RunState } from './types.js'

export interface SimEntry {
  from: 'contact' | 'bot' | 'event'
  text: string
  at: string
  nodeId?: string | null
}

interface Session {
  id: string
  userId: string
  def: FlowDefinition
  state: RunState
  status: 'waiting' | 'done' | 'transferred' | 'closed' | 'failed' | 'idle'
  history: ChatMessage[]
  transcript: SimEntry[]
  visited: string[]
  contact: any
  pendingTimer: string | null
  error?: string
  touchedAt: number
}

const sessions = new Map<string, Session>()
setInterval(() => {
  const now = Date.now()
  for (const [k, s] of sessions) if (now - s.touchedAt > 60 * 60_000) sessions.delete(k)
}, 10 * 60_000).unref()

function push(s: Session, from: SimEntry['from'], text: string) {
  s.transcript.push({ from, text, at: new Date().toISOString(), nodeId: s.state.currentNodeId })
  if (from === 'bot') {
    const last = s.history[s.history.length - 1]
    if (last?.role === 'assistant') last.content += `\n${text}`
    else s.history.push({ role: 'assistant', content: text })
  }
}

function simIO(s: Session): FlowIO {
  const fakeConv: any = { id: `sim-${s.id}`, connection_id: null, contact_id: null, context: {}, sector_id: null, status: 'automation', ai_paused: false }
  return {
    sim: true,
    contact: async () => s.contact,
    send: async (text) => {
      if (text.trim()) push(s, 'bot', text)
    },
    transfer: async (sectorId, userId, reason, priority) => {
      const sector = sectorId ? await one<any>(`SELECT name FROM sectors WHERE id=$1`, [sectorId]) : null
      const user = userId ? await one<any>(`SELECT name FROM users WHERE id=$1`, [userId]) : null
      push(s, 'event', `Transferida para ${user?.name ?? sector?.name ?? 'o setor de entrada'}${priority ? ` (prioridade ${priority})` : ''} — ${reason}`)
    },
    close: async (reason) => push(s, 'event', `Conversa encerrada — ${reason}`),
    addTags: async (ids) => {
      const names = ids.length ? (await one<any>(`SELECT string_agg(name, ', ') AS n FROM tags WHERE id = ANY($1)`, [ids]))?.n : ''
      push(s, 'event', `Etiquetas adicionadas: ${names || '—'}`)
    },
    updateContact: async (p) => {
      if (p.name) s.contact.name = p.name
      if (p.email) s.contact.email = p.email
      if (p.origin) s.contact.origin = p.origin
      if (p.leadStatus) s.contact.lead_status = p.leadStatus
      if (p.custom) s.contact.custom = { ...(s.contact.custom ?? {}), ...p.custom }
      push(s, 'event', `Contato atualizado: ${Object.keys(p).join(', ')}`)
    },
    agentTurn: async (agentId, extra) => runAgentTurn(fakeConv, { agentId, executeOutcome: false, extraInstructions: extra, dryRun: { history: s.history, contact: s.contact, send: async () => {} } }),
    aiJson: async (system, user, hint) => {
      const r = await runChat('triage', { system, messages: [{ role: 'user', content: user || '(vazio)' }], json: true, mockHint: hint, timeoutMs: 20_000 }, null)
      return parseJsonLoose(r.text)
    },
    isSectorOpen: async (sectorId) => {
      const sec = await one<any>(`SELECT * FROM sectors WHERE id=$1`, [sectorId])
      const open = sec ? await isSectorOpen(sec) : true
      push(s, 'event', `Horário de ${sec?.name ?? 'setor'}: ${open ? 'aberto' : 'fechado'} agora`)
      return open
    },
    scheduleTimer: async (ms, token) => {
      s.pendingTimer = token
      push(s, 'event', `Temporizador de ${Math.round(ms / 60000)} min (use "Avançar tempo" para simular)`)
    },
    runQuery: async (queryId, params) => {
      const { executeSavedQuery } = await import('../integrations/queries.js')
      return executeSavedQuery(queryId, params, { conversationId: null, actor: 'test' })
    },
    event: async (type, data) => push(s, 'event', `${type} ${JSON.stringify(data)}`),
    history: async () => s.history,
  }
}

async function step(s: Session, entry: { resumed: boolean; input: string | null; timer: boolean }) {
  const res = await execute(s.def, s.state, simIO(s), entry)
  s.state = res.state
  s.status = res.status
  s.error = res.error
  for (const st of res.steps) if (s.visited[s.visited.length - 1] !== st.nodeId) s.visited.push(st.nodeId)
  if (res.status === 'failed') push(s, 'event', `Erro: ${res.error}`)
  if (res.status === 'done') push(s, 'event', 'Fim do fluxo — a conversa seguiria com o agente de IA padrão')
}

export function view(s: Session) {
  return {
    sessionId: s.id,
    status: s.status,
    currentNodeId: s.state.currentNodeId,
    waitingFor: s.state.waitingFor,
    vars: s.state.vars,
    contact: { name: s.contact.name, email: s.contact.email, score: s.contact.score, lead_status: s.contact.lead_status, lead_profile: s.contact.lead_profile, score_breakdown: s.contact.score_breakdown },
    transcript: s.transcript,
    visited: s.visited,
    pendingTimer: !!s.pendingTimer,
  }
}

export async function simulate(userId: string, def: FlowDefinition, action: { sessionId?: string; type: 'start' | 'message' | 'timer'; text?: string }) {
  let s = action.sessionId ? sessions.get(action.sessionId) : undefined
  if (s && s.userId !== userId) s = undefined
  if (action.type === 'start' || !s) {
    s = {
      id: randomUUID(),
      userId,
      def,
      state: { vars: {}, currentNodeId: null, waitingFor: null, retries: 0, wakeToken: null },
      status: 'idle',
      history: [],
      transcript: [],
      visited: [],
      contact: { name: 'Contato de teste', push_name: 'Contato de teste', phone: '5541999990000', lead_profile: {}, score: null, score_breakdown: [], lead_status: 'novo', custom: {} },
      pendingTimer: null,
      touchedAt: Date.now(),
    }
    sessions.set(s.id, s)
    if (action.type === 'start' && !action.text) {
      push(s, 'event', 'Simulação iniciada. Envie a primeira mensagem como se fosse o contato.')
      return view(s)
    }
  }
  s.touchedAt = Date.now()
  s.def = def
  if (action.type === 'timer') {
    if (!s.pendingTimer) return view(s)
    s.pendingTimer = null
    await step(s, { resumed: true, input: null, timer: true })
    return view(s)
  }
  const text = (action.text ?? '').trim()
  if (!text) return view(s)
  push(s, 'contact', text)
  const last = s.history[s.history.length - 1]
  if (last?.role === 'user') last.content += `\n${text}`
  else s.history.push({ role: 'user', content: text })

  if (s.status === 'idle') await step(s, { resumed: false, input: null, timer: false })
  else if (s.status === 'waiting') await step(s, { resumed: true, input: text, timer: false })
  else push(s, 'event', 'O fluxo já terminou nesta simulação. Clique em "Reiniciar" para testar de novo.')
  return view(s)
}
