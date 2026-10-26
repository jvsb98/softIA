import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { SessionUser } from '../../auth/service.js'
import { one, q } from '../../lib/db.js'
import { audit } from '../../ops/audit.js'
import {
  addMessage,
  assign,
  broadcastConversation,
  closeConversation,
  CONVERSATION_SELECT,
  conversationView,
  getConversation,
  getOrOpenConversation,
  logEvent,
  markRead,
  returnToAutomation,
  transfer,
  upsertContact,
  type Actor,
} from '../../inbox/service.js'
import { sendMedia, sendText } from '../../inbox/outbound.js'
import { manager } from '../../whatsapp/manager.js'
import { digits } from '../../whatsapp/jid.js'
import { emitConversation } from '../realtime.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { clientIp, currentUser } from '../app.js'

const uuid = z.string().uuid()

const actorOf = (u: SessionUser): Actor => ({ type: 'agent', id: u.id, name: u.name })

/** Atendente vê conversas dos seus setores e as atribuídas a ele; gestores veem tudo. */
async function loadVisible(req: FastifyRequest, id: string) {
  const u = currentUser(req)
  const conv = await getConversation(id)
  if (!conv) throw notFound('Conversa não encontrada.')
  if (u.role !== 'agent') return { u, conv }
  const allowed = conv.assignee_id === u.id || (conv.sector_id && u.sectorIds.includes(conv.sector_id))
  if (!allowed) throw forbidden('Esta conversa não pertence aos seus setores.')
  return { u, conv }
}

export async function inboxRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ lista da caixa de entrada
  app.get('/api/conversations', async (req) => {
    const u = currentUser(req)
    const qs = z
      .object({
        view: z.enum(['mine', 'queue', 'automation', 'open', 'closed', 'all']).default('mine'),
        sectorId: uuid.optional(),
        connectionId: uuid.optional(),
        assigneeId: uuid.optional(),
        search: z.string().max(80).optional(),
        tagId: uuid.optional(),
        before: z.string().optional(),
        limit: z.coerce.number().min(1).max(100).default(50),
      })
      .parse(req.query)

    const where: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => {
      params.push(v)
      return `$${params.length}`
    }
    if (qs.view === 'mine') where.push(`c.status='open' AND c.assignee_id=${p(u.id)}`)
    else if (qs.view === 'queue') where.push(`c.status='queued'`)
    else if (qs.view === 'automation') where.push(`c.status='automation'`)
    else if (qs.view === 'open') where.push(`c.status='open'`)
    else if (qs.view === 'closed') where.push(`c.status='closed'`)
    if (u.role === 'agent' && qs.view !== 'mine') {
      where.push(`(c.sector_id = ANY(${p(u.sectorIds)}) OR c.assignee_id = ${p(u.id)})`)
    }
    if (qs.sectorId) where.push(`c.sector_id=${p(qs.sectorId)}`)
    if (qs.connectionId) where.push(`c.connection_id=${p(qs.connectionId)}`)
    if (qs.assigneeId) where.push(`c.assignee_id=${p(qs.assigneeId)}`)
    if (qs.tagId) where.push(`EXISTS (SELECT 1 FROM contact_tags x WHERE x.contact_id=c.contact_id AND x.tag_id=${p(qs.tagId)})`)
    if (qs.search) {
      const s = qs.search.trim()
      const d = digits(s)
      where.push(
        `(lower(coalesce(ct.name,'') || ' ' || coalesce(ct.push_name,'') || ' ' || coalesce(ct.email,'')) LIKE ${p('%' + s.toLowerCase() + '%')}` +
          (d.length >= 4 ? ` OR ct.phone LIKE ${p('%' + d + '%')}` : '') +
          ` OR c.last_message_preview ILIKE ${p('%' + s + '%')})`,
      )
    }
    if (qs.before) where.push(`c.last_message_at < ${p(qs.before)}`)
    const order = qs.view === 'queue' ? `c.priority DESC, c.queued_at ASC NULLS LAST` : `c.last_message_at DESC NULLS LAST`
    const rows = await q(
      `${CONVERSATION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${p(qs.limit)}`,
      params,
    )
    return rows
  })

  app.get('/api/conversations/counts', async (req) => {
    const u = currentUser(req)
    const scope = u.role === 'agent' ? `AND (sector_id = ANY($2) OR assignee_id = $1)` : ''
    const r = await one(
      `SELECT
         count(*) FILTER (WHERE status='open' AND assignee_id=$1) AS mine,
         count(*) FILTER (WHERE status='open' AND assignee_id=$1 AND unread_count>0) AS mine_unread,
         count(*) FILTER (WHERE status='queued' ${scope}) AS queue,
         count(*) FILTER (WHERE status='automation' ${scope}) AS automation,
         count(*) FILTER (WHERE status='open' ${scope}) AS open
       FROM conversations WHERE status <> 'closed'`,
      u.role === 'agent' ? [u.id, u.sectorIds] : [u.id],
    )
    return r
  })

  app.get('/api/conversations/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    await loadVisible(req, id)
    const view = await conversationView(id)
    const contact = await one(`SELECT * FROM contacts WHERE id=$1`, [(view as any).contact_id])
    const history = await q(
      `SELECT id, status, created_at, closed_at, close_reason, (SELECT name FROM sectors s WHERE s.id=c.sector_id) AS sector
         FROM conversations c WHERE contact_id=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 10`,
      [(view as any).contact_id, id],
    )
    return { ...view, contactFull: contact, history }
  })

  app.get('/api/conversations/:id/messages', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const qs = z.object({ before: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(60) }).parse(req.query)
    await loadVisible(req, id)
    const rows = await q(
      `SELECT * FROM (
         SELECT m.*, u.name AS sender_name,
                CASE WHEN mf.id IS NULL THEN NULL ELSE json_build_object('id', mf.id, 'mime', mf.mime, 'filename', mf.filename, 'size', mf.size) END AS media,
                CASE WHEN qm.id IS NULL THEN NULL ELSE json_build_object('id', qm.id, 'body', qm.body, 'kind', qm.kind, 'direction', qm.direction) END AS quoted
           FROM messages m
           LEFT JOIN users u ON u.id=m.sender_user_id
           LEFT JOIN media_files mf ON mf.id=m.media_id
           LEFT JOIN messages qm ON qm.id=m.quoted_message_id
          WHERE m.conversation_id=$1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
          ORDER BY m.created_at DESC LIMIT $3) x
       ORDER BY created_at ASC`,
      [id, qs.before ?? null, qs.limit],
    )
    const events = await q(
      `SELECT e.*, u.name AS actor_name FROM conversation_events e LEFT JOIN users u ON u.id=e.actor_id
        WHERE e.conversation_id=$1 ORDER BY e.created_at`,
      [id],
    )
    return { messages: rows, events }
  })

  // ------------------------------------------------------------ ações do atendente
  app.post('/api/conversations/:id/send', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ text: z.string().min(1).max(4096), quotedMessageId: uuid.nullable().optional() }).parse(req.body)
    const { u, conv } = await loadVisible(req, id)
    if (conv.status === 'closed') throw badRequest('Conversa encerrada. Reabra para responder.')
    // Ao responder, o atendente assume a conversa (se ninguém estava com ela)
    if (conv.status !== 'open' || !conv.assignee_id) await assign(id, u.id, actorOf(u))
    const text = u.signature ? `*${u.signature}:*\n${b.text}` : b.text
    const msg = await sendText(id, text, { senderType: 'agent', senderUserId: u.id, quotedMessageId: b.quotedMessageId ?? null, immediate: true })
    return msg
  })

  app.post('/api/conversations/:id/media', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { u, conv } = await loadVisible(req, id)
    if (conv.status === 'closed') throw badRequest('Conversa encerrada.')
    const file = await (req as any).file()
    if (!file) throw badRequest('Envie um arquivo.')
    const buf: Buffer = await file.toBuffer()
    const caption = (file.fields?.caption?.value as string | undefined) || null
    const media = await one<any>(
      `INSERT INTO media_files(mime, filename, size, sha256, data) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [file.mimetype || 'application/octet-stream', file.filename, buf.length, createHash('sha256').update(buf).digest('hex'), buf],
    )
    if (conv.status !== 'open' || !conv.assignee_id) await assign(id, u.id, actorOf(u))
    return sendMedia(id, media.id, caption, { senderType: 'agent', senderUserId: u.id })
  })

  app.post('/api/conversations/:id/notes', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ text: z.string().min(1).max(4000) }).parse(req.body)
    const { u, conv } = await loadVisible(req, id)
    // menções @Nome notificam o colega
    const msg = await addMessage({
      conversationId: id,
      connectionId: conv.connection_id,
      direction: 'internal',
      senderType: 'agent',
      senderUserId: u.id,
      kind: 'note',
      body: b.text,
    })
    const mentions = [...b.text.matchAll(/@([\p{L}][\p{L}\s]{1,40}?)(?=\s|$|[,.!?])/gu)].map((m) => m[1]!.trim().toLowerCase())
    if (mentions.length) {
      const users = await q<any>(`SELECT id, name FROM users WHERE active AND platform_user_id IS NULL`)
      const { emitUser } = await import('../realtime.js')
      for (const usr of users) {
        if (mentions.some((m) => usr.name.toLowerCase().startsWith(m)) && usr.id !== u.id)
          emitUser(usr.id, 'notify', { type: 'mention', conversationId: id, title: `${u.name} mencionou você`, body: b.text.slice(0, 140) })
      }
    }
    return msg
  })

  app.post('/api/conversations/:id/assign', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ userId: uuid.optional() }).parse(req.body ?? {})
    const { u } = await loadVisible(req, id)
    const target = b.userId ?? u.id
    if (target !== u.id && u.role === 'agent') throw forbidden('Só gestores podem atribuir conversas a outras pessoas.')
    return assign(id, target, actorOf(u))
  })

  app.post('/api/conversations/:id/transfer', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ sectorId: uuid.nullable().optional(), userId: uuid.nullable().optional(), note: z.string().max(1000).optional() }).parse(req.body)
    const { u, conv } = await loadVisible(req, id)
    if (!b.sectorId && !b.userId) throw badRequest('Escolha um setor ou um atendente.')
    if (b.note) {
      await addMessage({ conversationId: id, connectionId: conv.connection_id, direction: 'internal', senderType: 'agent', senderUserId: u.id, kind: 'note', body: `↪ Transferência: ${b.note}` })
    }
    return transfer(id, { sectorId: b.sectorId ?? undefined, userId: b.userId ?? undefined }, actorOf(u), b.note ? `Transferido por ${u.name}: ${b.note}` : `Transferido por ${u.name}`)
  })

  app.post('/api/conversations/:id/close', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ reason: z.string().max(200).optional(), farewell: z.string().max(1000).optional() }).parse(req.body ?? {})
    const { u } = await loadVisible(req, id)
    if (b.farewell) await sendText(id, b.farewell, { senderType: 'agent', senderUserId: u.id, immediate: true })
    return closeConversation(id, actorOf(u), b.reason)
  })

  app.post('/api/conversations/:id/automation', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { u } = await loadVisible(req, id)
    return returnToAutomation(id, actorOf(u))
  })

  app.post('/api/conversations/:id/read', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { conv } = await loadVisible(req, id)
    // confirma leitura no WhatsApp (dois tiques azuis) das mensagens recebidas
    const unread = await q<any>(
      `SELECT wa_id, meta FROM messages WHERE conversation_id=$1 AND direction='in' AND status='received' AND wa_id IS NOT NULL ORDER BY created_at DESC LIMIT 30`,
      [id],
    )
    const conn = manager.get(conv.connection_id)
    if (conn?.isConnected() && unread.length) {
      await conn.readMessages(unread.map((m) => ({ remoteJid: m.meta?.key?.remoteJid, id: m.wa_id, fromMe: false })).filter((k) => k.remoteJid))
      await q(`UPDATE messages SET status='read' WHERE conversation_id=$1 AND direction='in' AND status='received'`, [id])
    }
    return markRead(id)
  })

  app.post('/api/conversations/:id/priority', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ priority: z.number().int().min(0).max(3) }).parse(req.body)
    await loadVisible(req, id)
    await q(`UPDATE conversations SET priority=$2 WHERE id=$1`, [id, b.priority])
    return broadcastConversation(id)
  })

  app.post('/api/conversations/:id/typing', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ typing: z.boolean() }).parse(req.body)
    const { conv } = await loadVisible(req, id)
    const contact = await one<any>(`SELECT phone, lid FROM contacts WHERE id=$1`, [conv.contact_id])
    const jid = contact?.phone ? `${contact.phone}@s.whatsapp.net` : contact?.lid
    if (jid) await manager.get(conv.connection_id)?.presence(jid, b.typing ? 'composing' : 'paused')
    return { ok: true }
  })

  /** Atendente inicia conversa com um número (envio ativo individual). */
  app.post('/api/conversations/start', async (req) => {
    const u = currentUser(req)
    const b = z
      .object({ connectionId: uuid, phone: z.string().min(8).max(20), name: z.string().max(120).optional(), text: z.string().min(1).max(4096), sectorId: uuid.optional() })
      .parse(req.body)
    const conn = manager.get(b.connectionId)
    if (!conn?.isConnected()) throw badRequest('Esta conexão não está conectada ao WhatsApp.')
    let phone = digits(b.phone)
    if (phone.length === 10 || phone.length === 11) phone = '55' + phone
    const look = await conn.lookup(phone)
    if (!look.exists) throw badRequest('Este número não tem WhatsApp.')
    const realPhone = digits(look.jid!.split('@')[0])
    const contact = await upsertContact({ phone: realPhone })
    if (contact.opted_out) throw badRequest('Este contato pediu para não receber mensagens.')
    if (b.name && !contact.name) await q(`UPDATE contacts SET name=$2 WHERE id=$1`, [contact.id, b.name])
    const { conv } = await getOrOpenConversation(b.connectionId, contact.id)
    const sectorId = b.sectorId ?? conv.sector_id ?? u.sectorIds[0] ?? null
    await q(`UPDATE conversations SET sector_id=coalesce($2, sector_id) WHERE id=$1`, [conv.id, sectorId])
    await assign(conv.id, u.id, actorOf(u))
    await logEvent(conv.id, 'conversation.started_by_agent', actorOf(u), {})
    await sendText(conv.id, u.signature ? `*${u.signature}:*\n${b.text}` : b.text, { senderType: 'agent', senderUserId: u.id, immediate: true })
    await audit({ userId: u.id, action: 'conversation.started', entity: 'conversation', entityId: conv.id, ip: clientIp(req) })
    return conversationView(conv.id)
  })

  // ------------------------------------------------------------ contatos
  app.get('/api/contacts', async (req) => {
    currentUser(req)
    const qs = z.object({ search: z.string().max(80).optional(), status: z.string().optional(), limit: z.coerce.number().max(200).default(50), offset: z.coerce.number().default(0) }).parse(req.query)
    const s = (qs.search ?? '').trim()
    const d = digits(s)
    return q(
      `SELECT ct.*, (SELECT count(*) FROM conversations c WHERE c.contact_id=ct.id) AS conversations,
              coalesce((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color)) FROM contact_tags x JOIN tags t ON t.id=x.tag_id WHERE x.contact_id=ct.id),'[]') AS tags
         FROM contacts ct
        WHERE ct.anonymized_at IS NULL
          AND ($1 = '' OR lower(coalesce(ct.name,'')||' '||coalesce(ct.push_name,'')||' '||coalesce(ct.email,'')) LIKE '%'||lower($1)||'%' OR ($2 <> '' AND ct.phone LIKE '%'||$2||'%'))
          AND ($3::text IS NULL OR ct.lead_status=$3)
        ORDER BY ct.last_interaction_at DESC NULLS LAST LIMIT $4 OFFSET $5`,
      [s, d.length >= 4 ? d : '', qs.status ?? null, qs.limit, qs.offset],
    )
  })

  app.get('/api/contacts/:id', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const c = await one(`SELECT * FROM contacts WHERE id=$1`, [id])
    if (!c) throw notFound()
    const tags = await q(`SELECT t.* FROM contact_tags x JOIN tags t ON t.id=x.tag_id WHERE x.contact_id=$1`, [id])
    const conversations = await q(`SELECT id, status, created_at, closed_at, connection_id FROM conversations WHERE contact_id=$1 ORDER BY created_at DESC`, [id])
    return { ...c, tags, conversations }
  })

  app.patch('/api/contacts/:id', async (req) => {
    const u = currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z
      .object({
        name: z.string().max(120).nullable().optional(),
        email: z.string().email().nullable().optional().or(z.literal('')),
        notes: z.string().max(4000).nullable().optional(),
        isCustomer: z.boolean().optional(),
        leadStatus: z.enum(['novo', 'em_qualificacao', 'qualificado', 'desqualificado', 'cliente']).optional(),
        origin: z.string().max(80).nullable().optional(),
        optedOut: z.boolean().optional(),
        custom: z.record(z.string(), z.any()).optional(),
      })
      .parse(req.body)
    await q(
      `UPDATE contacts SET
         name = CASE WHEN $2 THEN $3 ELSE name END,
         email = CASE WHEN $4 THEN nullif($5,'') ELSE email END,
         notes = CASE WHEN $6 THEN $7 ELSE notes END,
         is_customer = coalesce($8, is_customer),
         lead_status = coalesce($9, lead_status),
         origin = CASE WHEN $10 THEN $11 ELSE origin END,
         opted_out = coalesce($12, opted_out),
         custom = CASE WHEN $13::jsonb IS NULL THEN custom ELSE custom || $13::jsonb END,
         updated_at = now()
       WHERE id=$1`,
      [
        id,
        b.name !== undefined,
        b.name ?? null,
        b.email !== undefined,
        b.email ?? null,
        b.notes !== undefined,
        b.notes ?? null,
        b.isCustomer ?? null,
        b.leadStatus ?? null,
        b.origin !== undefined,
        b.origin ?? null,
        b.optedOut ?? null,
        b.custom ? JSON.stringify(b.custom) : null,
      ],
    )
    await audit({ userId: u.id, action: 'contact.updated', entity: 'contact', entityId: id, data: { fields: Object.keys(b) }, ip: clientIp(req) })
    const convs = await q<any>(`SELECT id FROM conversations WHERE contact_id=$1 AND status<>'closed'`, [id])
    for (const c of convs) await broadcastConversation(c.id)
    return one(`SELECT * FROM contacts WHERE id=$1`, [id])
  })

  app.put('/api/contacts/:id/tags', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ tagIds: z.array(uuid) }).parse(req.body)
    await q(`DELETE FROM contact_tags WHERE contact_id=$1`, [id])
    for (const t of b.tagIds) await q(`INSERT INTO contact_tags VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, t])
    const convs = await q<any>(`SELECT id FROM conversations WHERE contact_id=$1 AND status<>'closed'`, [id])
    for (const c of convs) await broadcastConversation(c.id)
    return { ok: true }
  })

  /** LGPD: exporta todos os dados de um contato (direito de acesso do titular). */
  app.get('/api/contacts/:id/export', async (req, reply) => {
    const u = currentUser(req)
    if (u.role === 'agent') throw forbidden()
    const { id } = z.object({ id: uuid }).parse(req.params)
    const contact = await one(`SELECT * FROM contacts WHERE id=$1`, [id])
    if (!contact) throw notFound()
    const conversations = await q(`SELECT * FROM conversations WHERE contact_id=$1 ORDER BY created_at`, [id])
    const messages = await q(
      `SELECT m.created_at, m.direction, m.sender_type, m.kind, m.body, m.transcript FROM messages m JOIN conversations c ON c.id=m.conversation_id
        WHERE c.contact_id=$1 AND m.direction <> 'internal' ORDER BY m.created_at`,
      [id],
    )
    await audit({ userId: u.id, action: 'lgpd.export', entity: 'contact', entityId: id, ip: clientIp(req) })
    reply.header('Content-Disposition', `attachment; filename="contato-${id}.json"`)
    return { exportedAt: new Date().toISOString(), contact, conversations, messages }
  })

  /** LGPD: anonimiza o contato (direito de eliminação). Mantém estatísticas, remove dados pessoais e conteúdo. */
  app.post('/api/contacts/:id/anonymize', async (req) => {
    const u = currentUser(req)
    if (u.role !== 'admin') throw forbidden()
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { anonymizeContact } = await import('../../ops/retention.js')
    await anonymizeContact(id)
    await audit({ userId: u.id, action: 'lgpd.anonymize', entity: 'contact', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  // ------------------------------------------------------------ mídia
  app.get('/api/media/:id', async (req, reply) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const f = await one<any>(`SELECT mime, filename, data FROM media_files WHERE id=$1 AND deleted_at IS NULL`, [id])
    if (!f?.data) throw notFound('Arquivo não disponível (pode ter sido removido pela política de retenção).')
    reply.header('Content-Type', f.mime)
    reply.header('Cache-Control', 'private, max-age=86400')
    const safeName = (f.filename ?? 'arquivo').replace(/[^\w.\- ]/g, '_')
    // Arquivo vindo do WhatsApp pode ser HTML/SVG: só imagem, áudio e vídeo abrem inline, e sempre em sandbox
    const inlineOk = /^(image\/(png|jpe?g|gif|webp)|audio\/|video\/)/i.test(f.mime ?? '')
    reply.header('Content-Disposition', `${(req.query as any)?.download || !inlineOk ? 'attachment' : 'inline'}; filename="${safeName}"`)
    reply.header('Content-Security-Policy', 'sandbox')
    reply.header('X-Content-Type-Options', 'nosniff')
    return reply.send(f.data)
  })

  app.post('/api/messages/:id/retry', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params)
    const m = await one<any>(`SELECT conversation_id, status FROM messages WHERE id=$1`, [id])
    if (!m) throw notFound()
    await loadVisible(req, m.conversation_id)
    if (m.status !== 'failed') throw badRequest('Só mensagens com falha podem ser reenviadas.')
    const { enqueue } = await import('../../lib/jobs.js')
    await q(`UPDATE messages SET status='queued', error=NULL WHERE id=$1`, [id])
    await enqueue('wa.send', { messageId: id, immediate: true }, { groupKey: `out:${m.conversation_id}`, maxAttempts: 4 })
    const conv = await getConversation(m.conversation_id)
    if (conv) emitConversation(conv, 'message:status', { id, status: 'queued', conversation_id: m.conversation_id })
    return { ok: true }
  })
}
