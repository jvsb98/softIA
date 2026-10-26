/**
 * Follow-ups automáticos: retoma conversas paradas, só com quem já interagiu.
 *  - no máximo N tentativas, nos intervalos configurados (padrão 24h e 72h);
 *  - só dentro do horário do setor escolhido;
 *  - para na hora se o contato responder, pedir para parar ou for desqualificado;
 *  - depois da última tentativa sem resposta, encerra a conversa (opcional).
 * Também detecta pedidos de "parar" em qualquer mensagem recebida (opt-out).
 */
import { one, q } from '../lib/db.js'
import { every, work } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { hooks } from '../inbox/hooks.js'
import { closeConversation, logEvent } from '../inbox/service.js'
import { sendText } from '../inbox/outbound.js'
import { checkCompliance } from '../ai/guard.js'
import { runChat } from '../ai/router.js'
import { holidaySet, isWithinHours } from './hours.js'
import { getSetting } from './settings.js'

interface Attempt {
  afterHours: number
  message: string
  useAi?: boolean
}

const DEFAULTS = {
  enabled: true,
  onlyBusinessHours: true,
  hoursSectorSlug: 'atendimento',
  applyTo: 'automation' as 'automation' | 'all',
  attempts: [] as Attempt[],
  autoCloseAfterHours: 48,
  optOutKeywords: ['parar', 'sair', 'pare', 'nao quero mais', 'não quero mais', 'remover', 'descadastrar'],
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

async function aiFollowup(conversationId: string, fallback: string) {
  const rows = await q<any>(
    `SELECT direction, body FROM messages WHERE conversation_id=$1 AND direction<>'internal' AND kind='text' AND status<>'blocked' ORDER BY created_at DESC LIMIT 12`,
    [conversationId],
  )
  const transcript = rows
    .reverse()
    .map((r) => `${r.direction === 'in' ? 'Contato' : 'Empresa'}: ${r.body}`)
    .join('\n')
  try {
    const r = await runChat(
      'summary',
      {
        system:
          'Escreva UMA mensagem curta e cordial de retomada para um contato que parou de responder no WhatsApp da empresa, retomando o último assunto. Sem pressão, sem promessas, no máximo 2 frases. Responda só com a mensagem.',
        messages: [{ role: 'user', content: transcript || '(sem histórico)' }],
        mockHint: 'agent',
        timeoutMs: 20_000,
      },
      conversationId,
    )
    const text = r.text.trim()
    if (!text) return fallback
    const g = await checkCompliance(text, conversationId)
    return g.ok ? text : fallback
  } catch {
    return fallback
  }
}

export async function runFollowups() {
  const cfg = await getSetting('followups', DEFAULTS)
  if (!cfg.enabled || !cfg.attempts?.length) return
  if (cfg.onlyBusinessHours) {
    const sector = await one<any>(`SELECT * FROM sectors WHERE slug=$1`, [cfg.hoursSectorSlug])
    if (sector && !isWithinHours(sector, new Date(), await holidaySet())) return
  }
  const statusFilter = cfg.applyTo === 'all' ? `c.status IN ('automation','queued','open')` : `c.status='automation'`
  const candidates = await q<any>(
    `SELECT c.id, c.context, c.last_outbound_at, c.last_inbound_at, ct.name, ct.push_name, ct.opted_out, ct.lead_status
       FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
      WHERE ${statusFilter}
        AND c.last_inbound_at IS NOT NULL                       -- só quem já interagiu
        AND c.last_outbound_at IS NOT NULL AND c.last_outbound_at > c.last_inbound_at  -- a última fala foi nossa
        AND NOT ct.opted_out AND ct.lead_status NOT IN ('desqualificado')
        AND c.last_outbound_at < now() - interval '1 hour'
      ORDER BY c.last_outbound_at
      LIMIT 200`,
  )
  for (const c of candidates) {
    const fu = c.context?.followups ?? { sent: 0 }
    // Reinicia a contagem quando o contato respondeu depois do último follow-up
    const sameInbound = fu.lastInboundAt && new Date(fu.lastInboundAt).getTime() === new Date(c.last_inbound_at).getTime()
    const sentSince = sameInbound ? Number(fu.sent ?? 0) : 0
    const hoursSinceOurLast = (Date.now() - new Date(c.last_outbound_at).getTime()) / 3600_000
    const hoursSinceTheirLast = (Date.now() - new Date(c.last_inbound_at).getTime()) / 3600_000
    if (sentSince >= cfg.attempts.length) {
      if (cfg.autoCloseAfterHours && hoursSinceOurLast >= cfg.autoCloseAfterHours) {
        await closeConversation(c.id, { type: 'system' }, 'Sem resposta do cliente após follow-ups')
      }
      continue
    }
    const attempt = cfg.attempts[sentSince]!
    if (hoursSinceTheirLast < attempt.afterHours) continue
    const name = (c.name || c.push_name || '').split(' ')[0] || ''
    const base = attempt.message.replace(/\{\{\s*nome\s*\}\}/gi, name).replace(/^,\s*/, '').trim()
    const text = attempt.useAi ? await aiFollowup(c.id, base) : base
    await sendText(c.id, text, { senderType: 'system', meta: { followup: sentSince + 1 } })
    await q(`UPDATE conversations SET context = jsonb_set(context, '{followups}', $2::jsonb) WHERE id=$1`, [
      c.id,
      JSON.stringify({ sent: sentSince + 1, lastInboundAt: new Date(c.last_inbound_at).toISOString(), at: new Date().toISOString() }),
    ])
    await logEvent(c.id, 'followup.sent', { type: 'system' }, { attempt: sentSince + 1 })
  }
  if (candidates.length) log().debug({ checked: candidates.length }, 'Follow-ups verificados')
}

export function registerFollowups() {
  work('ops.followups', async () => runFollowups(), 1)
  every(10 * 60 * 1000, 'ops.followups')

  // Opt-out por palavra-chave em qualquer mensagem recebida (antes da IA)
  hooks.registerInbound('opt-out', async ({ message, contact, conversation }) => {
    if (message.kind !== 'text' || !message.body) return
    const cfg = await getSetting('followups', DEFAULTS)
    const t = norm(message.body)
    const hit = (cfg.optOutKeywords ?? []).some((k: string) => t === norm(k) || t === `${norm(k)}.` || t === `${norm(k)}!`)
    if (!hit || contact.opted_out) return
    await q(`UPDATE contacts SET opted_out=true, updated_at=now() WHERE id=$1`, [contact.id])
    await logEvent(conversation.id, 'contact.opted_out', { type: 'contact' }, { keyword: message.body })
    void import('../integrations/webhooks.js').then((w) => w.fireEvent('contact.opted_out', { conversationId: conversation.id })).catch(() => {})
  })

  hooks.registerInbound('webhook-message', async ({ message, conversation }) => {
    void import('../integrations/webhooks.js')
      .then((w) => w.fireEvent('message.received', { conversationId: conversation.id, message: { id: message.id, kind: message.kind, body: message.body, at: message.created_at } }))
      .catch(() => {})
  })
}
