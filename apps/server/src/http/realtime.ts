/**
 * Tempo real (Socket.IO). Multi-cliente: o cliente vem do hostname do handshake e TODA sala leva o
 * prefixo dele ("t:<id>:"), então um evento nunca chega a outro cliente. Cada usuário entra nas salas:
 *   user:<id>     — eventos pessoais (atribuições, notificações)
 *   sector:<id>   — conversas dos setores de que participa
 *   managers      — admins e supervisores (veem tudo)
 *   staff         — todos os usuários logados (status das conexões, presença)
 */
import type { Server as HttpServer } from 'node:http'
import { Server } from 'socket.io'
import { resolveSession } from '../auth/service.js'
import { q } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { ctxKey, runInCtx, tenantOrNull, type TenantCtx } from '../lib/tenant.js'
import { normalizeHost, resolveHost } from '../platform/tenants.js'

let io: Server | null = null
const online = new Map<string, number>() // "t:<cliente>:<usuário>" → nº de abas/conexões

/** Sala com o prefixo do cliente atual; null (e nada é emitido) fora de um contexto de cliente. */
function room(name: string): string | null {
  if (!tenantOrNull()) {
    log().warn({ room: name }, 'Evento de tempo real fora de um contexto de cliente foi descartado')
    return null
  }
  return ctxKey() + name
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

let allowedDevOrigin: (o: string) => boolean = () => false

export function initRealtime(server: HttpServer, allowedOrigin: (o: string | undefined) => boolean) {
  // Em desenvolvimento o Vite (localhost:5173) abre o socket para o servidor de outra porta
  allowedDevOrigin = (o) => {
    try {
      const h = new URL(o).hostname
      return process.env.NODE_ENV !== 'production' && (h === 'localhost' || h === '127.0.0.1')
    } catch {
      return false
    }
  }
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: (o, cb) => cb(null, allowedOrigin(o)), credentials: true },
    serveClient: false,
  })

  io.use(async (socket, next) => {
    try {
      const host = socket.handshake.headers.host
      const r = await resolveHost(host)
      if (r.kind !== 'tenant' || r.tenant.status === 'suspenso') return next(new Error('unauthorized'))
      // A origem precisa ser o próprio cliente (evita outro subdomínio abrir socket com o cookie deste)
      const origin = socket.handshake.headers.origin
      if (origin) {
        try {
          if (normalizeHost(new URL(origin).host) !== normalizeHost(host) && !allowedDevOrigin(origin)) return next(new Error('unauthorized'))
        } catch {
          return next(new Error('unauthorized'))
        }
      }
      const tenant: TenantCtx = r.tenant
      const token = parseCookies(socket.handshake.headers.cookie).na_session
      const s = await runInCtx(tenant, () => resolveSession(token))
      if (!s || s.mfaPending) return next(new Error('unauthorized'))
      socket.data.user = s.user
      socket.data.tenant = tenant
      next()
    } catch (err) {
      next(err as Error)
    }
  })

  io.on('connection', (socket) => {
    const tenant: TenantCtx = socket.data.tenant
    runInCtx(tenant, () => {
      const user = socket.data.user
      const p = ctxKey()
      socket.join(`${p}user:${user.id}`)
      socket.join(`${p}staff`)
      if (user.role !== 'agent') socket.join(`${p}managers`)
      for (const sid of user.sectorIds) socket.join(`${p}sector:${sid}`)

      const key = p + user.id
      const n = (online.get(key) ?? 0) + 1
      online.set(key, n)
      if (n === 1) void setPresence(user.id, 'online')

      const inCtx = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => runInCtx(tenant, () => fn(...a))
      socket.on('conversation:watch', inCtx((conversationId: string) => {
        if (typeof conversationId === 'string') socket.join(`${p}conversation:${conversationId}`)
      }))
      socket.on('conversation:unwatch', inCtx((conversationId: string) => {
        if (typeof conversationId === 'string') socket.leave(`${p}conversation:${conversationId}`)
      }))
      socket.on('typing', inCtx((d: { conversationId: string; typing: boolean }) => {
        if (d?.conversationId) socket.to(`${p}conversation:${d.conversationId}`).emit('agent:typing', { ...d, userId: user.id, name: user.name })
      }))
      socket.on('presence', inCtx((pr: 'online' | 'away') => {
        if (pr === 'online' || pr === 'away') void setPresence(user.id, pr)
      }))
      socket.on('disconnect', inCtx(() => {
        const left = (online.get(key) ?? 1) - 1
        if (left <= 0) {
          online.delete(key)
          void setPresence(user.id, 'offline')
        } else online.set(key, left)
      }))
    })
  })
  log().info('Tempo real (Socket.IO) ativo')
  return io
}

async function setPresence(userId: string, presence: 'online' | 'away' | 'offline') {
  await q(`UPDATE users SET presence=$2, last_seen_at=now() WHERE id=$1`, [userId, presence]).catch(() => {})
  emitStaff('user:presence', { userId, presence })
}

export function isOnline(userId: string) {
  const t = tenantOrNull()
  return t ? (online.get(ctxKey() + userId) ?? 0) > 0 : false
}

export function emitStaff(event: string, data: unknown) {
  const r = room('staff')
  if (r) io?.to(r).emit(event, data)
}

export function emitManagers(event: string, data: unknown) {
  const r = room('managers')
  if (r) io?.to(r).emit(event, data)
}

export function emitUser(userId: string, event: string, data: unknown) {
  const r = room(`user:${userId}`)
  if (r) io?.to(r).emit(event, data)
}

/** Envia um evento de conversa para quem pode vê-la (setor, responsável, gestores, quem está com ela aberta). */
export function emitConversation(
  conv: { id: string; sector_id?: string | null; assignee_id?: string | null },
  event: string,
  data: unknown,
) {
  if (!io) return
  const managers = room('managers')
  if (!managers) return
  const p = ctxKey()
  let target = io.to(managers).to(`${p}conversation:${conv.id}`)
  if (conv.sector_id) target = target.to(`${p}sector:${conv.sector_id}`)
  if (conv.assignee_id) target = target.to(`${p}user:${conv.assignee_id}`)
  target.emit(event, data)
}

/** Derruba todos os sockets de um cliente (suspensão/cancelamento). */
export function disconnectTenantSockets(tenantId: string) {
  io?.in(`t:${tenantId}:staff`).disconnectSockets(true)
}

export function realtime() {
  return io
}
