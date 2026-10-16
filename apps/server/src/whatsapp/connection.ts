/**
 * Uma conexão WhatsApp (um número), via Baileys — mesmo núcleo validado no Extrator de Integrantes:
 *  - versão do WhatsApp Web consultada a cada conexão (a embutida na biblioteca envelhece rápido);
 *  - patch do companion_reg_refresh (pasta patches/) para o pareamento por QR não falhar;
 *  - identidade fixa "Chrome (Windows)";
 *  - sessão que nunca pareou é descartada antes de gerar um novo QR.
 */
import { EventEmitter } from 'node:events'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  generateMessageIDV2,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import pino from 'pino'
import QRCode from 'qrcode'
import { one } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { discardUnpairedSession, usePostgresAuthState } from './auth-state.js'
import { isIgnorableJid, rememberLid } from './jid.js'

export type ConnStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error'

export interface ConnectionEvents {
  status: (s: { status: ConnStatus; qr?: string | null; error?: string | null; phone?: string | null; pushName?: string | null }) => void
  message: (m: WAMessage, type: string) => void
  receipt: (waId: string, status: 'sent' | 'delivered' | 'read') => void
}

const BACKOFF = [2_000, 5_000, 15_000, 30_000, 60_000]

export class WaConnection extends EventEmitter {
  sock: WASocket | null = null
  status: ConnStatus = 'disconnected'
  qr: string | null = null
  lastError: string | null = null
  private retries = 0
  private stopping = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private qrShown = 0
  /** IDs de mensagens enviadas pelo sistema (para distinguir de envios feitos pelo celular). */
  readonly ownIds = new Set<string>()
  private readonly baileysLog = pino({ level: process.env.WA_LOG_LEVEL || 'warn' })

  constructor(readonly id: string, readonly name: string) {
    super()
  }

  isConnected() {
    return this.status === 'connected' && !!this.sock
  }

  private setStatus(status: ConnStatus, extra: { qr?: string | null; error?: string | null } = {}) {
    this.status = status
    if (extra.qr !== undefined) this.qr = extra.qr
    if (status !== 'qr') this.qr = null
    if (extra.error !== undefined) this.lastError = extra.error
    this.emit('status', {
      status,
      qr: this.qr,
      error: this.lastError,
      phone: this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id).split('@')[0] : null,
      pushName: this.sock?.user?.name ?? null,
    })
  }

  async start() {
    if (this.sock && ['connected', 'connecting', 'qr'].includes(this.status)) return
    this.stopping = false
    this.setStatus('connecting', { error: null })
    const l = log().child({ conn: this.name })

    await discardUnpairedSession(this.id).catch(() => false)
    const { state, saveCreds } = await usePostgresAuthState(this.id)

    const { version, isLatest } = await fetchLatestWaWebVersion().catch(() => ({ version: undefined, isLatest: false }) as any)
    if (version) l.info(`Versão do WhatsApp Web: ${version.join('.')}${isLatest ? '' : ' (padrão da biblioteca)'}`)

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.baileysLog) },
      logger: this.baileysLog,
      browser: Browsers.windows('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: (jid) => isIgnorableJid(jid),
      getMessage: async (key) => {
        // Usado pelo Baileys para reenviar mensagens que o destinatário não conseguiu decifrar.
        const row = await one<any>(`SELECT body FROM messages WHERE connection_id=$1 AND wa_id=$2`, [this.id, key.id])
        return row?.body ? { conversation: row.body } : undefined
      },
    })
    this.sock = sock
    this.qrShown = 0

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      if (lid && pn) void rememberLid(lid, pn).catch(() => {})
    })
    const onContacts = (list: any[]) => {
      for (const c of list ?? []) {
        if (c?.lid && c?.phoneNumber) void rememberLid(c.lid, c.phoneNumber).catch(() => {})
        else if (c?.id?.endsWith?.('@lid') && c?.phoneNumber) void rememberLid(c.id, c.phoneNumber).catch(() => {})
      }
    }
    sock.ev.on('contacts.upsert', onContacts)
    sock.ev.on('contacts.update', onContacts as any)

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u
      if (qr) {
        this.qrShown++
        try {
          const img = await QRCode.toDataURL(qr, { margin: 1, width: 360, color: { dark: '#071832', light: '#ffffff' } })
          this.setStatus('qr', { qr: img })
          l.info('QR Code gerado — aguardando leitura no celular')
        } catch (err) {
          l.error({ err }, 'Falha ao gerar imagem do QR Code')
        }
      }
      if (connection === 'open') {
        this.retries = 0
        this.setStatus('connected', { error: null })
        l.info({ me: sock.user?.id }, 'WhatsApp conectado')
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const message = (lastDisconnect?.error as Error | undefined)?.message ?? 'Conexão encerrada'
        this.sock = null
        if (this.stopping) {
          this.setStatus('disconnected')
          return
        }
        if (code === DisconnectReason.loggedOut) {
          l.warn('Sessão encerrada pelo celular (aparelho desconectado). Será preciso ler o QR Code de novo.')
          const { clear } = await usePostgresAuthState(this.id)
          await clear()
          this.setStatus('logged_out', { error: 'O aparelho foi desconectado no celular. Gere um novo QR Code.' })
          return
        }
        if (code === DisconnectReason.connectionReplaced) {
          this.setStatus('error', { error: 'Esta sessão foi aberta em outro lugar (conexão substituída).' })
          return
        }
        if (code === DisconnectReason.timedOut && /QR refs attempts ended/i.test(message)) {
          await discardUnpairedSession(this.id).catch(() => false)
          this.setStatus('disconnected', { error: 'O QR Code expirou sem ser lido. Clique em "Gerar QR Code" para tentar de novo.' })
          return
        }
        if (code === DisconnectReason.restartRequired) {
          l.info('Reinício solicitado pelo WhatsApp após o pareamento — reconectando')
          void this.start()
          return
        }
        const wait = BACKOFF[Math.min(this.retries, BACKOFF.length - 1)]!
        this.retries++
        this.setStatus('connecting', { error: `${message} (código ${code ?? '?'}) — reconectando em ${Math.round(wait / 1000)}s` })
        l.warn({ code, message, wait }, 'Conexão caiu; nova tentativa agendada')
        this.reconnectTimer = setTimeout(() => void this.start(), wait)
      }
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) this.emit('message', m, type)
    })
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const st = (update as any)?.status
        if (!key?.id || st == null) continue
        if (st >= 4) this.emit('receipt', key.id, 'read')
        else if (st === 3) this.emit('receipt', key.id, 'delivered')
        else if (st === 2) this.emit('receipt', key.id, 'sent')
      }
    })
  }

  async stop() {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.sock?.end(undefined)
    } catch {
      /* ignora */
    }
    this.sock = null
    this.setStatus('disconnected')
  }

  /** Desconecta o aparelho (remove dos "Aparelhos conectados" do celular) e apaga a sessão. */
  async logout() {
    this.stopping = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      await this.sock?.logout()
    } catch {
      /* já estava desconectado */
    }
    this.sock = null
    const { clear } = await usePostgresAuthState(this.id)
    await clear()
    this.setStatus('logged_out', { error: null })
  }

  async presence(jid: string, type: 'composing' | 'paused' | 'available') {
    try {
      await this.sock?.sendPresenceUpdate(type, jid)
    } catch {
      /* presença é melhor-esforço */
    }
  }

  async readMessages(keys: { remoteJid: string; id: string; fromMe?: boolean }[]) {
    try {
      await this.sock?.readMessages(keys as any)
    } catch {
      /* ignora */
    }
  }

  async download(m: WAMessage): Promise<Buffer | null> {
    if (!this.sock) return null
    try {
      return (await downloadMediaMessage(m, 'buffer', {}, { logger: this.baileysLog, reuploadRequest: this.sock.updateMediaMessage })) as Buffer
    } catch (err) {
      log().warn({ err: (err as Error).message }, 'Não foi possível baixar a mídia')
      return null
    }
  }

  /**
   * Envia uma mensagem a partir da linha da tabela messages (texto ou mídia).
   * Gera o ID antes do envio para que o eco recebido via messages.upsert seja reconhecido como nosso.
   */
  async sendFromMessage(jid: string, m: any): Promise<string> {
    if (!this.sock) throw new Error('Desconectado')
    const messageId = generateMessageIDV2(this.sock.user?.id)
    this.ownIds.add(messageId)
    setTimeout(() => this.ownIds.delete(messageId), 10 * 60_000).unref()
    // grava o ID antes do envio (o eco pode chegar antes do retorno do sendMessage)
    await one(`UPDATE messages SET wa_id=$2 WHERE id=$1`, [m.id, messageId])

    let quoted: any
    if (m.quoted_message_id) {
      const qm = await one<any>(`SELECT wa_id, body, direction, meta FROM messages WHERE id=$1`, [m.quoted_message_id])
      if (qm?.wa_id) {
        quoted = {
          key: { remoteJid: jid, id: qm.wa_id, fromMe: qm.direction === 'out' },
          message: { conversation: qm.body ?? '' },
        }
      }
    }

    let content: any
    if (m.media_id) {
      const f = await one<any>(`SELECT mime, filename, data FROM media_files WHERE id=$1`, [m.media_id])
      if (!f?.data) throw new Error('Arquivo não encontrado')
      const buf: Buffer = f.data
      if (m.kind === 'image') content = { image: buf, caption: m.body ?? undefined, mimetype: f.mime }
      else if (m.kind === 'video') content = { video: buf, caption: m.body ?? undefined, mimetype: f.mime }
      else if (m.kind === 'audio') content = { audio: buf, mimetype: f.mime, ptt: /ogg|opus/.test(f.mime) }
      else content = { document: buf, mimetype: f.mime, fileName: f.filename ?? 'arquivo', caption: m.body ?? undefined }
    } else {
      content = { text: m.body ?? '' }
    }
    const sent = await this.sock.sendMessage(jid, content, { messageId, quoted })
    return sent?.key?.id ?? messageId
  }

  /** Verifica se um número tem WhatsApp e devolve o JID correto. */
  async lookup(phone: string): Promise<{ exists: boolean; jid?: string }> {
    if (!this.sock) throw new Error('Desconectado')
    const [r] = (await this.sock.onWhatsApp(phone)) ?? []
    return r?.exists ? { exists: true, jid: r.jid } : { exists: false }
  }
}
