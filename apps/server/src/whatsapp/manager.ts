/**
 * Gerencia todas as conexões (números) e transforma eventos do WhatsApp em atendimento.
 */
import { createHash } from 'node:crypto'
import type { WAMessage } from '@whiskeysockets/baileys'
import { one, q } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { emitStaff } from '../http/realtime.js'
import {
  addMessage,
  broadcastConversation,
  getOrOpenConversation,
  logEvent,
  scheduleProcessing,
  updateStatusByWaId,
  upsertContact,
} from '../inbox/service.js'
import { hooks } from '../inbox/hooks.js'
import { WaConnection, type ConnStatus } from './connection.js'
import { digits, isIgnorableJid, lidOf, phoneForLid, phoneFromPnJid, rememberLid } from './jid.js'
import { parseMessage } from './parse.js'

const MAX_AGE_MS = 24 * 60 * 60 * 1000 // ignora mensagens mais velhas que 24h (histórico)

class Manager {
  private conns = new Map<string, WaConnection>()

  get(id: string) {
    return this.conns.get(id)
  }

  list() {
    return [...this.conns.values()]
  }

  /** Na inicialização: reconecta automaticamente quem já tem sessão pareada. */
  async startAll() {
    const rows = await q<any>(
      `SELECT c.id, c.name, EXISTS (SELECT 1 FROM wa_auth_keys k WHERE k.connection_id=c.id AND k.category='creds' AND k.value ? 'me') AS paired
         FROM connections c WHERE c.enabled`,
    )
    for (const r of rows) {
      const conn = this.ensure(r.id, r.name)
      if (r.paired) await conn.start().catch((err) => log().error({ err, conn: r.name }, 'Falha ao iniciar conexão'))
      else await this.persistStatus(r.id, 'disconnected', null)
    }
    log().info({ total: rows.length }, 'Conexões WhatsApp inicializadas')
  }

  ensure(id: string, name: string) {
    let conn = this.conns.get(id)
    if (conn) return conn
    conn = new WaConnection(id, name)
    conn.on('status', (s) => void this.onStatus(id, s))
    conn.on('message', (m: WAMessage, type: string) => {
      this.onMessage(conn!, m, type).catch((err) => log().error({ err, conn: name }, 'Erro ao processar mensagem recebida'))
    })
    conn.on('receipt', (waId: string, status: 'sent' | 'delivered' | 'read') => {
      void updateStatusByWaId(id, waId, status).catch(() => {})
    })
    this.conns.set(id, conn)
    return conn
  }

  async connect(id: string) {
    const row = await one<any>(`SELECT id, name FROM connections WHERE id=$1`, [id])
    if (!row) throw new Error('Conexão não encontrada')
    const conn = this.ensure(row.id, row.name)
    await conn.start()
    return conn
  }

  async disconnect(id: string) {
    await this.conns.get(id)?.stop()
  }

  async logout(id: string) {
    const conn = this.conns.get(id) ?? this.ensure(id, id)
    await conn.logout()
  }

  async remove(id: string) {
    const conn = this.conns.get(id)
    if (conn) {
      await conn.stop()
      this.conns.delete(id)
    }
  }

  async stopAll() {
    await Promise.all([...this.conns.values()].map((c) => c.stop()))
  }

  private async persistStatus(id: string, status: ConnStatus, error: string | null, phone?: string | null, pushName?: string | null) {
    await q(
      `UPDATE connections SET status=$2, last_error=$3,
              phone = coalesce($4, phone), push_name = coalesce($5, push_name),
              last_connected_at = CASE WHEN $2='connected' THEN now() ELSE last_connected_at END
        WHERE id=$1`,
      [id, status, error, phone ?? null, pushName ?? null],
    )
  }

  private async onStatus(id: string, s: { status: ConnStatus; qr?: string | null; error?: string | null; phone?: string | null; pushName?: string | null }) {
    await this.persistStatus(id, s.status, s.error ?? null, s.phone, s.pushName).catch(() => {})
    emitStaff('connection:status', { id, ...s })
    if (s.status === 'connected' || s.status === 'logged_out') {
      void import('../integrations/webhooks.js').then((w) => w.fireEvent(`connection.${s.status}`, { connectionId: id, phone: s.phone })).catch(() => {})
    }
  }

  /** Mensagem recebida (ou enviada pelo celular) → contato, conversa, mensagem e automação. */
  private async onMessage(conn: WaConnection, m: WAMessage, _type: string) {
    const key = m.key
    const jid = key?.remoteJid
    if (!key?.id || !jid || isIgnorableJid(jid) || !m.message) return
    const ts = Number(m.messageTimestamp ?? 0) * 1000
    if (ts && Date.now() - ts > MAX_AGE_MS) return

    const fromMe = !!key.fromMe
    if (fromMe && conn.ownIds.has(key.id)) return // eco de mensagem enviada pelo sistema
    if (await one(`SELECT 1 FROM messages WHERE connection_id=$1 AND wa_id=$2`, [conn.id, key.id])) return

    const parsed = parseMessage(m)
    if (parsed.kind === 'protocol') return

    // Identidade: telefone (PN) e/ou LID
    const alt = (key as any).remoteJidAlt as string | undefined
    const lid = lidOf(jid) ?? lidOf(alt)
    let phone = phoneFromPnJid(jid) ?? phoneFromPnJid(alt)
    if (!phone && lid) {
      phone = await phoneForLid(lid)
      if (!phone && conn.sock) {
        const pn = await conn.sock.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)
        if (pn) phone = digits(pn.split('@')[0]!.split(':')[0])
      }
    }
    if (lid && phone) await rememberLid(lid, phone).catch(() => {})

    // Reação: anexa à mensagem original, não vira mensagem nova
    if (parsed.kind === 'reaction') {
      if (parsed.reactionTo) {
        await q(
          `UPDATE messages SET meta = jsonb_set(meta, '{reaction}', to_jsonb($3::text)) WHERE connection_id=$1 AND wa_id=$2`,
          [conn.id, parsed.reactionTo, parsed.body ?? ''],
        )
      }
      return
    }

    const contact = await upsertContact({ phone, lid, pushName: fromMe ? null : m.pushName ?? null })
    if (!contact) return
    const { conv } = await getOrOpenConversation(conn.id, contact.id)

    // Mídia
    let mediaId: string | null = null
    if (parsed.hasMedia) {
      const buf = await conn.download(m)
      if (buf) {
        const sha = createHash('sha256').update(buf).digest('hex')
        const row = await one<{ id: string }>(
          `INSERT INTO media_files(mime, filename, size, sha256, data) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [parsed.mime ?? 'application/octet-stream', parsed.filename ?? null, buf.length, sha, buf],
        )
        mediaId = row?.id ?? null
      }
    }

    let quotedId: string | null = null
    if (parsed.quotedWaId) {
      const qm = await one<{ id: string }>(`SELECT id FROM messages WHERE connection_id=$1 AND wa_id=$2`, [conn.id, parsed.quotedWaId])
      quotedId = qm?.id ?? null
    }

    const msg = await addMessage({
      conversationId: conv.id,
      connectionId: conn.id,
      waId: key.id,
      direction: fromMe ? 'out' : 'in',
      senderType: fromMe ? 'phone' : 'contact',
      kind: parsed.kind,
      body: parsed.body,
      mediaId,
      quotedMessageId: quotedId,
      status: fromMe ? 'sent' : 'received',
      meta: {
        key: { remoteJid: jid, id: key.id, fromMe },
        ...(parsed.isPtt ? { ptt: true } : {}),
        ...(parsed.selectedOptionId ? { selectedOptionId: parsed.selectedOptionId } : {}),
      },
      createdAt: ts ? new Date(ts) : undefined,
    })
    if (!msg) return

    if (fromMe) {
      // Alguém respondeu pelo celular: o humano assumiu — pausa a automação nesta conversa.
      if (conv.status === 'automation' || !conv.ai_paused) {
        await q(
          `UPDATE conversations SET ai_paused=true,
                  status = CASE WHEN status='automation' THEN 'queued' ELSE status END,
                  queued_at = CASE WHEN status='automation' THEN now() ELSE queued_at END,
                  handoff_reason = coalesce(handoff_reason, 'Respondido pelo celular')
            WHERE id=$1`,
          [conv.id],
        )
        await q(`UPDATE jobs SET status='done', finished_at=now(), last_error='cancelado: resposta pelo celular' WHERE status='queued' AND group_key=$1`, [
          `conv:${conv.id}`,
        ])
        await logEvent(conv.id, 'phone.reply', { type: 'phone' }, { note: 'Resposta enviada pelo celular — automação pausada' })
        await broadcastConversation(conv.id)
      }
      return
    }

    await hooks.onInbound({ conversation: conv, contact, message: msg, connection: conn })

    if (conv.status === 'automation' && !conv.ai_paused) {
      await scheduleProcessing(conv.id, 'inbound')
    }
  }
}

export const manager = new Manager()
