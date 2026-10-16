/**
 * Domínio do atendimento: contatos, conversas, mensagens, transferências e distribuição.
 */
import type pg from 'pg'
import { one, q, tx, type Queryable } from '../lib/db.js'
import { enqueue } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { emitConversation, emitUser, isOnline } from '../http/realtime.js'
import { holidaySet, isWithinHours } from '../ops/hours.js'
import { getSetting } from '../ops/settings.js'

export type ActorType = 'system' | 'agent' | 'ai' | 'flow' | 'contact' | 'phone'
export interface Actor {
  type: ActorType
  id?: string | null
  name?: string
}
export const SYSTEM: Actor = { type: 'system' }

export interface ConversationRow {
  id: string
  connection_id: string
  contact_id: string
  status: 'automation' | 'queued' | 'open' | 'closed'
  sector_id: string | null
  assignee_id: string | null
  ai_paused: boolean
  handoff_reason: string | null
  context: Record<string, any>
  handoff_card: any
  priority: number
  unread_count: number
  last_message_at: string | null
  created_at: string
}

// ---------------------------------------------------------------- contatos

export async function upsertContact(input: { phone?: string | null; lid?: string | null; pushName?: string | null }) {
  const phone = input.phone || null
  const lid = input.lid || null
  let contact: any = phone ? await one(`SELECT * FROM contacts WHERE phone=$1`, [phone]) : null
  if (!contact && lid) contact = await one(`SELECT * FROM contacts WHERE lid=$1`, [lid])
  if (contact) {
    return one(
      `UPDATE contacts SET
          phone = CASE WHEN phone IS NULL AND $2::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.phone=$2) THEN $2 ELSE phone END,
          lid   = CASE WHEN lid   IS NULL AND $3::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.lid=$3)   THEN $3 ELSE lid END,
          push_name = coalesce($4, push_name),
          last_interaction_at = now(),
          updated_at = now()
        WHERE id=$1 RETURNING *`,
      [contact.id, phone, lid, input.pushName ?? null],
    )
  }
  const created = await one(
    `INSERT INTO contacts(phone, lid, push_name, last_interaction_at) VALUES ($1,$2,$3, now()) ON CONFLICT DO NOTHING RETURNING *`,
    [phone, lid, input.pushName ?? null],
  )
  return created ?? one(`SELECT * FROM contacts WHERE phone=$1 OR lid=$2 LIMIT 1`, [phone, lid])
}

export function contactDisplayName(c: { name?: string | null; push_name?: string | null; phone?: string | null }) {
  return c.name || c.push_name || (c.phone ? `+${c.phone}` : 'Contato')
}

// ---------------------------------------------------------------- conversas

export async function getConversation(id: string, c?: Queryable): Promise<ConversationRow | null> {
  return one<ConversationRow>(`SELECT * FROM conversations WHERE id=$1`, [id], c)
}

/**
 * Retorna a conversa aberta do contato neste número ou abre uma nova.
 * Se a última conversa foi encerrada por um humano há pouco tempo (janela de reabertura),
 * a nova conversa volta direto para a fila do mesmo setor, de preferência para o mesmo atendente.
 */
export async function getOrOpenConversation(connectionId: string, contactId: string): Promise<{ conv: ConversationRow; created: boolean }> {
  const existing = await one<ConversationRow>(
    `SELECT * FROM conversations WHERE connection_id=$1 AND contact_id=$2 AND status <> 'closed'`,
    [connectionId, contactId],
  )
  if (existing) return { conv: existing, created: false }

  const inbox = await getSetting('inbox', { reopenWindowHours: 24 })
  const last = await one<any>(
    `SELECT c.sector_id, c.assignee_id, c.closed_by FROM conversations c
      WHERE c.connection_id=$1 AND c.contact_id=$2 AND c.status='closed'
        AND c.closed_at > now() - ($3 || ' hours')::interval AND c.sector_id IS NOT NULL AND c.closed_by IS NOT NULL
      ORDER BY c.closed_at DESC LIMIT 1`,
    [connectionId, contactId, String(inbox.reopenWindowHours)],
  )
  const conn = await one<any>(`SELECT default_sector_id FROM connections WHERE id=$1`, [connectionId])
  try {
    const conv = await one<ConversationRow>(
      `INSERT INTO conversations(connection_id, contact_id, status, sector_id, context)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        connectionId,
        contactId,
        last ? 'queued' : 'automation',
        last?.sector_id ?? conn?.default_sector_id ?? null,
        JSON.stringify(last ? { reopenedFromHuman: true, preferredAgentId: last.assignee_id } : {}),
      ],
    )
    await logEvent(conv!.id, 'conversation.opened', SYSTEM, { reopened: !!last })
    if (last) {
      await q(`UPDATE conversations SET queued_at=now(), handoff_reason='Retorno do cliente após atendimento recente' WHERE id=$1`, [conv!.id])
      const fresh = (await getConversation(conv!.id))!
      await distribute(fresh, { preferredUserId: last.assignee_id })
      return { conv: (await getConversation(conv!.id))!, created: true }
    }
    return { conv: conv!, created: true }
  } catch (err: any) {
    // Corrida: outra mensagem abriu a conversa no mesmo instante.
    if (err?.code === '23505') {
      const conv = await one<ConversationRow>(
        `SELECT * FROM conversations WHERE connection_id=$1 AND contact_id=$2 AND status <> 'closed'`,
        [connectionId, contactId],
      )
      if (conv) return { conv, created: false }
    }
    throw err
  }
}

export async function logEvent(conversationId: string, type: string, actor: Actor, data: Record<string, unknown> = {}, c?: Queryable) {
  const row = await one(
    `INSERT INTO conversation_events(conversation_id, type, actor_type, actor_id, data) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [conversationId, type, actor.type, actor.id ?? null, JSON.stringify(data)],
    c,
  )
  const conv = await getConversation(conversationId, c)
  if (conv) emitConversation(conv, 'conversation:event', { ...row, actor_name: actor.name })
  return row
}

/** Conversa no formato da lista da caixa de entrada (com contato, setor, responsável e etiquetas). */
export async function conversationView(id: string) {
  return one(
    `${CONVERSATION_SELECT} WHERE c.id=$1`,
    [id],
  )
}

export const CONVERSATION_SELECT = `
  SELECT c.*,
         json_build_object('id', ct.id, 'name', ct.name, 'push_name', ct.push_name, 'phone', ct.phone, 'email', ct.email,
                           'lead_status', ct.lead_status, 'score', ct.score, 'is_customer', ct.is_customer,
                           'opted_out', ct.opted_out, 'origin', ct.origin,
                           'tags', coalesce((SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name)
                                               FROM contact_tags x JOIN tags t ON t.id = x.tag_id WHERE x.contact_id = ct.id), '[]'::json)) AS contact,
         CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name, 'color', s.color) END AS sector,
         CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'name', u.name, 'color', u.color) END AS assignee,
         json_build_object('id', cn.id, 'name', cn.name, 'color', cn.color, 'phone', cn.phone, 'status', cn.status) AS connection
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    JOIN connections cn ON cn.id = c.connection_id
    LEFT JOIN sectors s ON s.id = c.sector_id
    LEFT JOIN users u ON u.id = c.assignee_id`

export async function broadcastConversation(id: string) {
  const view = await conversationView(id)
  if (view) emitConversation(view, 'conversation:updated', view)
  return view
}

// ---------------------------------------------------------------- mensagens

export interface NewMessage {
  conversationId: string
  connectionId: string
  waId?: string | null
  direction: 'in' | 'out' | 'internal'
  senderType: 'contact' | 'agent' | 'ai' | 'flow' | 'system' | 'phone'
  senderUserId?: string | null
  kind?: string
  body?: string | null
  mediaId?: string | null
  quotedMessageId?: string | null
  status?: string
  meta?: Record<string, unknown>
  createdAt?: Date
}

export function previewOf(kind: string, body?: string | null) {
  const labels: Record<string, string> = {
    image: '📷 Imagem',
    audio: '🎤 Áudio',
    video: '🎬 Vídeo',
    document: '📄 Documento',
    sticker: 'Figurinha',
    location: '📍 Localização',
    contact: '👤 Contato',
    note: '📝 Nota interna',
  }
  const text = (body ?? '').replace(/\s+/g, ' ').trim()
  if (kind === 'text') return text.slice(0, 140)
  return text ? `${labels[kind] ?? kind}: ${text}`.slice(0, 140) : (labels[kind] ?? kind)
}

export async function addMessage(m: NewMessage): Promise<any | null> {
  const row = await one(
    `INSERT INTO messages(conversation_id, connection_id, wa_id, direction, sender_type, sender_user_id, kind, body, media_id,
                          quoted_message_id, status, meta, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, coalesce($13, now()))
     ON CONFLICT (connection_id, wa_id) WHERE wa_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      m.conversationId,
      m.connectionId,
      m.waId ?? null,
      m.direction,
      m.senderType,
      m.senderUserId ?? null,
      m.kind ?? 'text',
      m.body ?? null,
      m.mediaId ?? null,
      m.quotedMessageId ?? null,
      m.status ?? (m.direction === 'in' ? 'received' : 'sent'),
      JSON.stringify(m.meta ?? {}),
      m.createdAt ?? null,
    ],
  )
  if (!row) return null // duplicada (idempotência)

  if (m.direction !== 'internal') {
    const isIn = m.direction === 'in'
    await q(
      `UPDATE conversations SET
          last_message_at = greatest(coalesce(last_message_at, $2), $2),
          last_message_preview = $3,
          last_inbound_at  = CASE WHEN $4 THEN $2 ELSE last_inbound_at END,
          last_outbound_at = CASE WHEN $4 THEN last_outbound_at ELSE $2 END,
          unread_count = CASE WHEN $4 AND status IN ('queued','open') THEN unread_count + 1 ELSE unread_count END,
          first_response_at = CASE WHEN NOT $4 AND $5 AND first_response_at IS NULL AND assignee_id IS NOT NULL THEN $2 ELSE first_response_at END
        WHERE id = $1`,
      [m.conversationId, row.created_at, previewOf(row.kind, row.body), isIn, m.senderType === 'agent'],
    )
  }
  const full = await messageView(row.id)
  const conv = await getConversation(m.conversationId)
  if (conv) {
    emitConversation(conv, 'message:new', full)
    void broadcastConversation(conv.id)
  }
  return full
}

export async function messageView(id: string) {
  return one(
    `SELECT m.*, u.name AS sender_name,
            CASE WHEN mf.id IS NULL THEN NULL ELSE json_build_object('id', mf.id, 'mime', mf.mime, 'filename', mf.filename, 'size', mf.size) END AS media,
            CASE WHEN qm.id IS NULL THEN NULL ELSE json_build_object('id', qm.id, 'body', qm.body, 'kind', qm.kind, 'direction', qm.direction) END AS quoted
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN media_files mf ON mf.id = m.media_id
       LEFT JOIN messages qm ON qm.id = m.quoted_message_id
      WHERE m.id=$1`,
    [id],
  )
}

export async function updateMessageStatus(messageId: string, status: string, error?: string | null, waId?: string | null) {
  const row = await one(
    `UPDATE messages SET status=$2, error=$3, wa_id=coalesce(wa_id,$4) WHERE id=$1 RETURNING id, conversation_id, status, error, wa_id`,
    [messageId, status, error ?? null, waId ?? null],
  )
  if (row) {
    const conv = await getConversation(row.conversation_id)
    if (conv) emitConversation(conv, 'message:status', row)
  }
}

const STATUS_RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 }
export async function updateStatusByWaId(connectionId: string, waId: string, status: 'sent' | 'delivered' | 'read' | 'failed') {
  const row = await one(`SELECT id, status FROM messages WHERE connection_id=$1 AND wa_id=$2`, [connectionId, waId])
  if (!row) return
  if (status !== 'failed' && (STATUS_RANK[row.status] ?? 0) >= (STATUS_RANK[status] ?? 0)) return
  await updateMessageStatus(row.id, status)
}

// ---------------------------------------------------------------- distribuição

export async function sectorById(id: string | null | undefined, c?: Queryable) {
  if (!id) return null
  return one(`SELECT * FROM sectors WHERE id=$1`, [id], c)
}

export async function isSectorOpen(sector: any): Promise<boolean> {
  return isWithinHours(sector, new Date(), await holidaySet())
}

/**
 * Escolhe um atendente para a conversa conforme a regra do setor:
 *  - round_robin: próximo da fila entre os atendentes online (ou todos, se ninguém online)
 *  - least_busy: atendente online com menos conversas abertas
 *  - pull: não atribui; fica na fila para alguém "puxar"
 * Respeita o limite de conversas simultâneas de cada atendente.
 */
export async function pickAgent(sector: any, preferredUserId?: string | null): Promise<string | null> {
  const members = await q<{ id: string; open: number; max_concurrent: number; presence: string }>(
    `SELECT u.id, u.max_concurrent, u.presence,
            (SELECT count(*) FROM conversations c WHERE c.assignee_id=u.id AND c.status='open') AS open
       FROM sector_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.sector_id=$1 AND u.active
      ORDER BY u.created_at`,
    [sector.id],
  )
  const available = members.filter((m) => m.open < m.max_concurrent)
  if (!available.length) return null
  const online = available.filter((m) => isOnline(m.id) || m.presence === 'online')
  const pool = online.length ? online : available
  if (preferredUserId && pool.some((m) => m.id === preferredUserId)) return preferredUserId
  if (sector.distribution === 'pull') {
    // Setor com um único atendente: atribui direto mesmo em modo "puxar".
    return members.length === 1 ? pool[0]!.id : null
  }
  if (sector.distribution === 'least_busy') {
    return [...pool].sort((a, b) => a.open - b.open)[0]!.id
  }
  // round_robin
  const ids = pool.map((m) => m.id)
  const lastIdx = sector.last_assigned_user_id ? ids.indexOf(sector.last_assigned_user_id) : -1
  const next = ids[(lastIdx + 1) % ids.length]!
  await q(`UPDATE sectors SET last_assigned_user_id=$2 WHERE id=$1`, [sector.id, next])
  return next
}

/** Coloca a conversa na fila do setor e tenta atribuir um atendente. Envia mensagem de fora do horário quando aplicável. */
export async function distribute(conv: ConversationRow, opts: { preferredUserId?: string | null } = {}) {
  const sector = await sectorById(conv.sector_id)
  if (!sector) {
    await broadcastConversation(conv.id)
    return
  }
  const open = await isSectorOpen(sector)
  if (!open) {
    await maybeSendOffHours(conv, sector)
  }
  const agent = await pickAgent(sector, opts.preferredUserId ?? conv.context?.preferredAgentId)
  if (agent) {
    await assign(conv.id, agent, SYSTEM)
  } else {
    await broadcastConversation(conv.id)
  }
}

/** Envia (uma vez por período fechado) a mensagem fixa de fora do horário do setor. */
export async function maybeSendOffHours(conv: ConversationRow, sector: any) {
  const msg: string | null = sector.offhours_message
  if (!msg) return
  const already = await one(
    `SELECT 1 FROM conversation_events WHERE conversation_id=$1 AND type='offhours.sent' AND created_at > now() - interval '12 hours'`,
    [conv.id],
  )
  if (already) return
  const { sendText } = await import('./outbound.js')
  await sendText(conv.id, msg, { senderType: 'system', meta: { offhours: true } })
  await logEvent(conv.id, 'offhours.sent', SYSTEM, { sector: sector.name })
}

export async function transfer(
  conversationId: string,
  target: { sectorId?: string | null; userId?: string | null },
  actor: Actor,
  reason?: string,
  extra: { priority?: number; handoffCard?: any } = {},
) {
  const conv = await getConversation(conversationId)
  if (!conv) throw new Error('Conversa não encontrada')
  let sectorId = target.sectorId ?? conv.sector_id
  if (target.userId && !target.sectorId) {
    const m = await one<{ sector_id: string }>(`SELECT sector_id FROM sector_members WHERE user_id=$1 ORDER BY sector_id LIMIT 1`, [target.userId])
    if (m && !conv.sector_id) sectorId = m.sector_id
  }
  await q(
    `UPDATE conversations SET status='queued', sector_id=$2, assignee_id=NULL, queued_at=now(), handoff_reason=coalesce($3, handoff_reason),
            priority = greatest(priority, $4), handoff_card = coalesce($5, handoff_card)
      WHERE id=$1`,
    [conversationId, sectorId, reason ?? null, extra.priority ?? 0, extra.handoffCard ? JSON.stringify(extra.handoffCard) : null],
  )
  const sector = await sectorById(sectorId)
  await logEvent(conversationId, 'conversation.transferred', actor, {
    from_sector_id: conv.sector_id,
    to_sector_id: sectorId,
    to_sector: sector?.name,
    to_user_id: target.userId ?? null,
    reason: reason ?? null,
  })
  // Cancela automações pendentes da conversa (fluxo/IA) — o humano assume.
  await q(`UPDATE jobs SET status='done', finished_at=now(), last_error='cancelado: transferência' WHERE status='queued' AND group_key=$1 AND queue='conversation.process'`, [`conv:${conversationId}`])
  const fresh = (await getConversation(conversationId))!
  if (target.userId) {
    await assign(conversationId, target.userId, actor)
  } else {
    await distribute(fresh)
  }
  void import('../integrations/webhooks.js').then((w) => w.fireEvent('conversation.transferred', { conversationId, sectorId, reason })).catch(() => {})
  return broadcastConversation(conversationId)
}

export async function assign(conversationId: string, userId: string, actor: Actor) {
  const user = await one<any>(`SELECT id, name FROM users WHERE id=$1 AND active`, [userId])
  if (!user) throw new Error('Atendente não encontrado')
  const conv = await one<ConversationRow>(
    `UPDATE conversations SET status='open', assignee_id=$2, assigned_at=now(), ai_paused=true WHERE id=$1 RETURNING *`,
    [conversationId, userId],
  )
  if (!conv) throw new Error('Conversa não encontrada')
  await logEvent(conversationId, 'conversation.assigned', actor, { user_id: userId, user_name: user.name })
  const view = await broadcastConversation(conversationId)
  emitUser(userId, 'notify', {
    type: 'assigned',
    conversationId,
    title: 'Nova conversa atribuída',
    body: view ? `${(view as any).contact?.name || (view as any).contact?.push_name || 'Contato'} — ${conv.handoff_reason ?? 'Atendimento'}` : '',
  })
  return view
}

export async function closeConversation(conversationId: string, actor: Actor, reason?: string) {
  const conv = await one<ConversationRow>(
    `UPDATE conversations SET status='closed', closed_at=now(), closed_by=$2, close_reason=$3, unread_count=0
      WHERE id=$1 AND status <> 'closed' RETURNING *`,
    [conversationId, actor.type === 'agent' ? actor.id : null, reason ?? null],
  )
  if (!conv) return null
  await q(`UPDATE jobs SET status='done', finished_at=now(), last_error='cancelado: encerramento' WHERE status='queued' AND group_key=$1`, [
    `conv:${conversationId}`,
  ])
  await logEvent(conversationId, 'conversation.closed', actor, { reason: reason ?? null })
  void import('../integrations/webhooks.js').then((w) => w.fireEvent('conversation.closed', { conversationId, reason })).catch(() => {})
  return broadcastConversation(conversationId)
}

/** Devolve a conversa para a automação (fluxo/IA). */
export async function returnToAutomation(conversationId: string, actor: Actor) {
  await q(`UPDATE conversations SET status='automation', assignee_id=NULL, ai_paused=false WHERE id=$1`, [conversationId])
  await logEvent(conversationId, 'conversation.automation_resumed', actor, {})
  return broadcastConversation(conversationId)
}

export async function markRead(conversationId: string) {
  await q(`UPDATE conversations SET unread_count=0 WHERE id=$1`, [conversationId])
  return broadcastConversation(conversationId)
}

/** Agenda o processamento automático (fluxo/IA) com debounce — agrupa mensagens enviadas em sequência. */
export async function scheduleProcessing(conversationId: string, reason: 'inbound' | 'resume' | 'timer' = 'inbound', delayMs?: number) {
  const inbox = await getSetting('inbox', { debounceMs: 4500 })
  await enqueue(
    'conversation.process',
    { conversationId, reason },
    {
      singletonKey: `conv:${conversationId}`,
      groupKey: `conv:${conversationId}`,
      mode: 'debounce',
      delayMs: delayMs ?? inbox.debounceMs,
      maxAttempts: 3,
    },
  )
}

export async function withConversationLock<T>(conversationId: string, fn: (c: pg.PoolClient) => Promise<T>) {
  return tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`conv:${conversationId}`])
    return fn(c)
  })
}

export function logger() {
  return log()
}
