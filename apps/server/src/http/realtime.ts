/**
 * Tempo real (Socket.IO). Cada usuário entra nas salas:
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

let io: Server | null = null
const online = new Map<string, number>() // userId → nº de abas/conexões

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function initRealtime(server: HttpServer, allowedOrigin: (o: string | undefined) => boolean) {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: (o, cb) => cb(null, allowedOrigin(o)), credentials: true },
    serveClient: false,
  })

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie).na_session
      const s = await resolveSession(token)
      if (!s || s.mfaPending) return next(new Error('unauthorized'))
      socket.data.user = s.user
      next()
    } catch (err) {
      next(err as Error)
    }
  })

  io.on('connection', (socket) => {
    const user = socket.data.user
    socket.join(`user:${user.id}`)
    socket.join('staff')
    if (user.role !== 'agent') socket.join('managers')
    for (const sid of user.sectorIds) socket.join(`sector:${sid}`)

    const n = (online.get(user.id) ?? 0) + 1
    online.set(user.id, n)
    if (n === 1) void setPresence(user.id, 'online')

    socket.on('conversation:watch', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.join(`conversation:${conversationId}`)
    })
    socket.on('conversation:unwatch', (conversationId: string) => {
      if (typeof conversationId === 'string') socket.leave(`conversation:${conversationId}`)
    })
    socket.on('typing', (p: { conversationId: string; typing: boolean }) => {
      if (p?.conversationId) socket.to(`conversation:${p.conversationId}`).emit('agent:typing', { ...p, userId: user.id, name: user.name })
    })
    socket.on('presence', (p: 'online' | 'away') => {
      if (p === 'online' || p === 'away') void setPresence(user.id, p)
    })
    socket.on('disconnect', () => {
      const left = (online.get(user.id) ?? 1) - 1
      if (left <= 0) {
        online.delete(user.id)
        void setPresence(user.id, 'offline')
      } else online.set(user.id, left)
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
  return (online.get(userId) ?? 0) > 0
}

export function emitStaff(event: string, data: unknown) {
  io?.to('staff').emit(event, data)
}

export function emitManagers(event: string, data: unknown) {
  io?.to('managers').emit(event, data)
}

export function emitUser(userId: string, event: string, data: unknown) {
  io?.to(`user:${userId}`).emit(event, data)
}

/** Envia um evento de conversa para quem pode vê-la (setor, responsável, gestores, quem está com ela aberta). */
export function emitConversation(
  conv: { id: string; sector_id?: string | null; assignee_id?: string | null },
  event: string,
  data: unknown,
) {
  if (!io) return
  let target = io.to('managers').to(`conversation:${conv.id}`)
  if (conv.sector_id) target = target.to(`sector:${conv.sector_id}`)
  if (conv.assignee_id) target = target.to(`user:${conv.assignee_id}`)
  target.emit(event, data)
}

export function realtime() {
  return io
}
