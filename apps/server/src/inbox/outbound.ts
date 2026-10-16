/**
 * Envio de mensagens com "ritmo humano":
 *  - a mensagem é gravada como "queued" e entra na fila wa.send (ordem garantida por conversa);
 *  - o worker mostra "digitando…" por um tempo proporcional ao texto, respeita intervalo mínimo
 *    entre mensagens da mesma conversa e limite de mensagens por minuto por conexão.
 */
import { one } from '../lib/db.js'
import { enqueue, work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { getSetting } from '../ops/settings.js'
import { addMessage, updateMessageStatus } from './service.js'

export interface SendOptions {
  senderType?: 'agent' | 'ai' | 'flow' | 'system'
  senderUserId?: string | null
  quotedMessageId?: string | null
  meta?: Record<string, unknown>
  /** pula a simulação de digitação (ex.: mensagens do atendente, que já digitou) */
  immediate?: boolean
}

export async function sendText(conversationId: string, text: string, opts: SendOptions = {}) {
  const conv = await one<any>(`SELECT id, connection_id FROM conversations WHERE id=$1`, [conversationId])
  if (!conv) throw new Error('Conversa não encontrada')
  const msg = await addMessage({
    conversationId,
    connectionId: conv.connection_id,
    direction: 'out',
    senderType: opts.senderType ?? 'system',
    senderUserId: opts.senderUserId ?? null,
    kind: 'text',
    body: text,
    quotedMessageId: opts.quotedMessageId ?? null,
    status: 'queued',
    meta: opts.meta,
  })
  await enqueue('wa.send', { messageId: msg.id, immediate: !!opts.immediate }, { groupKey: `out:${conversationId}`, maxAttempts: 4 })
  return msg
}

export async function sendMedia(conversationId: string, mediaId: string, caption: string | null, opts: SendOptions = {}) {
  const conv = await one<any>(`SELECT id, connection_id FROM conversations WHERE id=$1`, [conversationId])
  const media = await one<any>(`SELECT id, mime, filename FROM media_files WHERE id=$1`, [mediaId])
  if (!conv || !media) throw new Error('Conversa ou arquivo não encontrado')
  const kind = media.mime.startsWith('image/')
    ? 'image'
    : media.mime.startsWith('video/')
      ? 'video'
      : media.mime.startsWith('audio/')
        ? 'audio'
        : 'document'
  const msg = await addMessage({
    conversationId,
    connectionId: conv.connection_id,
    direction: 'out',
    senderType: opts.senderType ?? 'agent',
    senderUserId: opts.senderUserId ?? null,
    kind,
    body: caption,
    mediaId,
    quotedMessageId: opts.quotedMessageId ?? null,
    status: 'queued',
    meta: opts.meta,
  })
  await enqueue('wa.send', { messageId: msg.id, immediate: true }, { groupKey: `out:${conversationId}`, maxAttempts: 4 })
  return msg
}

// ---------------------------------------------------------------- worker

const lastSentAt = new Map<string, number>() // por conversa
const connWindow = new Map<string, number[]>() // por conexão: horários dos últimos envios

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function handleSend(job: Job<{ messageId: string; immediate?: boolean }>) {
  const { manager } = await import('../whatsapp/manager.js')
  const m = await one<any>(
    `SELECT m.*, ct.phone, ct.lid, ct.opted_out, c.status AS conv_status
       FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
      WHERE m.id=$1`,
    [job.payload.messageId],
  )
  if (!m || !['queued', 'sending', 'failed'].includes(m.status)) return
  const conn = manager.get(m.connection_id)
  if (!conn || !conn.isConnected()) {
    // Sem conexão: tenta de novo mais tarde (o job volta para a fila com espera exponencial).
    await updateMessageStatus(m.id, 'queued', 'Aguardando conexão do WhatsApp')
    throw new Error('Conexão do WhatsApp indisponível')
  }
  const jid = m.phone ? `${m.phone}@s.whatsapp.net` : m.lid
  if (!jid) {
    await updateMessageStatus(m.id, 'failed', 'Contato sem número de WhatsApp')
    return
  }

  const pacing = await getSetting('pacing', {
    typingCharsPerSecond: 18,
    typingMinMs: 900,
    typingMaxMs: 6000,
    minGapMs: 1200,
    jitterMs: 900,
    perMinuteLimit: 20,
  })
  const jitter = () => Math.floor(Math.random() * pacing.jitterMs)

  // Limite por conexão (janela deslizante de 60s)
  const now = Date.now()
  const win = (connWindow.get(m.connection_id) ?? []).filter((t) => now - t < 60_000)
  if (win.length >= pacing.perMinuteLimit) {
    const wait = 60_000 - (now - win[0]!) + jitter()
    await sleep(wait)
  }
  // Intervalo mínimo na mesma conversa
  const last = lastSentAt.get(m.conversation_id) ?? 0
  const gap = Date.now() - last
  if (gap < pacing.minGapMs) await sleep(pacing.minGapMs - gap + jitter())

  await updateMessageStatus(m.id, 'sending')
  try {
    if (!job.payload.immediate && m.kind === 'text') {
      const typingMs = Math.min(
        pacing.typingMaxMs,
        Math.max(pacing.typingMinMs, ((m.body?.length ?? 0) / pacing.typingCharsPerSecond) * 1000) + jitter(),
      )
      await conn.presence(jid, 'composing')
      await sleep(typingMs)
      await conn.presence(jid, 'paused')
    }
    const waId = await conn.sendFromMessage(jid, m)
    await updateMessageStatus(m.id, 'sent', null, waId)
    lastSentAt.set(m.conversation_id, Date.now())
    connWindow.set(m.connection_id, [...win, Date.now()])
  } catch (err: any) {
    log().warn({ err: err?.message, messageId: m.id }, 'Falha ao enviar mensagem')
    if (job.attempts >= job.max_attempts) {
      await updateMessageStatus(m.id, 'failed', String(err?.message ?? err).slice(0, 500))
      return
    }
    await updateMessageStatus(m.id, 'queued', 'Nova tentativa em instantes')
    throw err
  }
}

export function registerOutboundWorker() {
  work('wa.send', handleSend, 4)
}
