/**
 * Gerencia todas as conexões (números) e transforma eventos do WhatsApp em atendimento.
 */
import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import type { WAMessage } from '@whiskeysockets/baileys'
import { one, q } from '../lib/db.js'
import { currentTenant, runInCtx, tenantOrNull, withPlatform, withTenant, type TenantCtx } from '../lib/tenant.js'
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
import { cancelGroup } from '../lib/jobs.js'

const MAX_AGE_MS = 24 * 60 * 60 * 1000 // ignora mensagens mais velhas que 24h (histórico)

/** Identifica este processo nas leases (só um processo segura cada número). */
const HOLDER = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`
const LEASE_SECONDS = 45
const HEARTBEAT_MS = 15_000

/**
 * Multi-cliente: as conexões ficam indexadas por "<cliente>:<conexão>" e cada uma guarda o contexto do
 * cliente dono; todo evento do Baileys é tratado dentro desse contexto. As consultas get/list/connect
 * só enxergam as conexões do cliente atual.
 */
class Manager {
  private conns = new Map<string, WaConnection>()
  private owners = new Map<string, TenantCtx>()
  private heartbeat: NodeJS.Timeout | null = null

  private key(id: string, t: TenantCtx = currentTenant()) {
    return `${t.id}:${id}`
  }

  get(id: string) {
    const t = tenantOrNull()
    return t ? this.conns.get(this.key(id, t)) : undefined
  }

  /** Conexões do cliente atual. */
  list() {
    const t = tenantOrNull()
    if (!t) return []
    const prefix = `${t.id}:`
    return [...this.conns.entries()].filter(([k]) => k.startsWith(prefix)).map(([, c]) => c)
  }

  /** Na inicialização: reconecta, em cada cliente ativo, quem já tem sessão pareada. */
  async startAll(tenants: TenantCtx[]) {
    for (const t of tenants) await withTenant(t, () => this.startTenant()).catch((err) => log().error({ err, tenant: t.slug }, 'Falha ao iniciar conexões do cliente'))
    this.startHeartbeat()
  }

  /** Inicia as conexões pareadas do cliente atual. */
  async startTenant() {
    const t = currentTenant()
    const rows = await q<any>(
      `SELECT c.id, c.name, EXISTS (SELECT 1 FROM wa_auth_keys k WHERE k.connection_id=c.id AND k.category='creds' AND k.value ? 'me') AS paired
         FROM connections c WHERE c.enabled`,
    )
    for (const r of rows) {
      if (r.paired) await this.startConn(r.id, r.name).catch((err) => log().error({ err, conn: r.name, tenant: t.slug }, 'Falha ao iniciar conexão'))
      else await this.persistStatus(r.id, 'disconnected', null)
    }
    log().info({ tenant: t.slug, total: rows.length }, 'Conexões WhatsApp inicializadas')
  }

  /** Para todas as conexões do cliente atual (suspensão, cancelamento). */
  async stopTenant() {
    for (const c of this.list()) await this.remove(c.id)
  }

  ensure(id: string, name: string) {
    const t = currentTenant()
    const k = this.key(id, t)
    let conn = this.conns.get(k)
    if (conn) return conn
    conn = new WaConnection(id, name)
    const inCtx = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => runInCtx(t, () => fn(...a))
    conn.on('status', inCtx((st: any) => void this.onStatus(id, st)))
    conn.on('message', inCtx((m: WAMessage, type: string) => {
      this.onMessage(conn!, m, type).catch((err) => log().error({ err, conn: name, tenant: t.slug }, 'Erro ao processar mensagem recebida'))
    }))
    conn.on('receipt', inCtx((waId: string, status: 'sent' | 'delivered' | 'read') => {
      void updateStatusByWaId(id, waId, status).catch(() => {})
    }))
    this.conns.set(k, conn)
    this.owners.set(k, t)
    return conn
  }

  /** Pega a lease do número e inicia a conexão. Sem lease (outro processo já segura), não inicia. */
  private async startConn(id: string, name: string) {
    const t = currentTenant()
    if (!(await this.acquireLease(t, id))) {
      log().warn({ conn: name, tenant: t.slug }, 'Outro processo já está com este número; nova tentativa quando a lease vencer')
      // Se o outro processo cair, a lease vence e este assume o número sozinho
      const retry = setTimeout(() => {
        void runInCtx(t, async () => {
          const still = await one(`SELECT 1 FROM connections WHERE id=$1 AND enabled`, [id]).catch(() => null)
          if (still) await this.startConn(id, name).catch((err) => log().error({ err, conn: name, tenant: t.slug }, 'Falha ao assumir a conexão'))
        })
      }, (LEASE_SECONDS + 5) * 1000)
      retry.unref()
      return this.ensure(id, name)
    }
    const conn = this.ensure(id, name)
    await conn.start()
    return conn
  }

  private async acquireLease(t: TenantCtx, connectionId: string): Promise<boolean> {
    const r = await withPlatform(() =>
      one<{ holder: string }>(
        `INSERT INTO wa_leases(tenant_id, connection_id, holder, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4))
         ON CONFLICT (tenant_id, connection_id) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at, updated_at=now()
           WHERE wa_leases.expires_at < now() OR wa_leases.holder = EXCLUDED.holder
         RETURNING holder`,
        [t.id, connectionId, HOLDER, LEASE_SECONDS],
      ),
    )
    return r?.holder === HOLDER
  }

  private async releaseLease(t: TenantCtx, connectionId: string) {
    await withPlatform(() => q(`DELETE FROM wa_leases WHERE tenant_id=$1 AND connection_id=$2 AND holder=$3`, [t.id, connectionId, HOLDER])).catch(() => {})
  }

  /** Renova as leases deste processo; a conexão cuja lease foi perdida é parada (outro processo assumiu). */
  private startHeartbeat() {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      void withPlatform(async () => {
        const kept = await q<{ tenant_id: string; connection_id: string }>(
          `UPDATE wa_leases SET expires_at = now() + make_interval(secs => $2), updated_at=now() WHERE holder=$1 RETURNING tenant_id, connection_id`,
          [HOLDER, LEASE_SECONDS],
        )
        const alive = new Set(kept.map((r) => `${r.tenant_id}:${r.connection_id}`))
        for (const [k, conn] of this.conns) {
          if (conn.status === 'disconnected' || conn.status === 'logged_out' || alive.has(k)) continue
          const owner = this.owners.get(k)
          if (!owner) continue
          log().warn({ conn: conn.name, tenant: owner.slug }, 'Lease do número perdida; parando a conexão neste processo')
          await runInCtx(owner, () => conn.stop()).catch(() => {})
        }
      }).catch((err) => log().error({ err }, 'Falha ao renovar leases do WhatsApp'))
    }, HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  async connect(id: string) {
    const row = await one<any>(`SELECT id, name FROM connections WHERE id=$1`, [id])
    if (!row) throw new Error('Conexão não encontrada')
    return this.startConn(row.id, row.name)
  }

  async disconnect(id: string) {
    await this.get(id)?.stop()
    await this.releaseLease(currentTenant(), id)
  }

  async logout(id: string) {
    const conn = this.get(id) ?? this.ensure(id, id)
    await conn.logout()
    await this.releaseLease(currentTenant(), id)
  }

  async remove(id: string) {
    const t = currentTenant()
    const k = this.key(id, t)
    const conn = this.conns.get(k)
    if (conn) {
      await conn.stop()
      this.conns.delete(k)
      this.owners.delete(k)
    }
    await this.releaseLease(t, id)
  }

  async stopAll() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    await Promise.all(
      [...this.conns.entries()].map(([k, c]) => {
        const owner = this.owners.get(k)
        return owner ? runInCtx(owner, async () => {
          await c.stop()
          await this.releaseLease(owner, c.id)
        }) : c.stop()
      }),
    )
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
    if (s.status === 'logged_out' || s.status === 'error') {
      const row = await one<any>(`SELECT name FROM connections WHERE id=$1`, [id]).catch(() => null)
      void import('../ops/notifications.js').then((n) =>
        n.notifyTeam(`conn:${id}:${s.status}`, `a conexão "${row?.name ?? id}" está ${s.status === 'logged_out' ? 'desconectada no celular (ler QR Code de novo)' : `com erro: ${s.error ?? ''}`}`, 'connection'),
      )
    }
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
        await cancelGroup(`conv:${conv.id}`, 'resposta pelo celular')
        await q(`UPDATE flow_runs SET status='cancelled', ended_at=now(), error='resposta pelo celular' WHERE conversation_id=$1 AND status IN ('running','waiting')`, [conv.id]).catch(() => {})
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
