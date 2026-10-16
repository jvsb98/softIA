import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fstatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import { effectivePermissions, resolveSession, type ResolvedSession, type Role } from '../auth/service.js'
import type { AppConfig } from '../lib/config.js'
import { log } from '../lib/logger.js'
import { forbidden, HttpError, unauthorized } from './errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    session?: ResolvedSession | null
  }
}

export const SESSION_COOKIE = 'na_session'

export function currentUser(req: FastifyRequest) {
  const s = req.session
  if (!s || s.mfaPending) throw unauthorized()
  return s.user
}

export function requireRole(req: FastifyRequest, ...roles: Role[]) {
  const u = currentUser(req)
  if (!roles.includes(u.role)) throw forbidden()
  return u
}

export function requirePermission(req: FastifyRequest, perm: 'flowsAdvanced' | 'flowsEdit' | 'kbEdit' | 'reports') {
  const u = currentUser(req)
  if (!effectivePermissions(u.role, u.permissions)[perm]) throw forbidden()
  return u
}

export function clientIp(req: FastifyRequest) {
  return req.ip
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: 60 * 60 * 24 * 30 })
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}

const PUBLIC_PREFIXES = ['/api/health', '/api/setup/', '/api/auth/login', '/api/auth/2fa/verify', '/api/auth/logout', '/api/public/']

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: cfg.server.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  })

  const publicOrigin = new URL(cfg.server.publicUrl).origin
  const allowedOrigin = (origin: string | undefined) => {
    if (!origin) return true
    if (origin === publicOrigin) return true
    try {
      const u = new URL(origin)
      // mesmo host (acessado por IP/nome diferente na rede local) ou ambiente de desenvolvimento do Vite
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    } catch {
      return false
    }
    return false
  }
  ;(app as any).allowedOrigin = allowedOrigin

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    hsts: cfg.server.publicUrl.startsWith('https://') ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
  // JSON tolerante a corpo vazio (POST de ação sem parâmetros)
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (!text.trim()) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch {
      const err: any = new Error('JSON inválido no corpo da requisição')
      err.statusCode = 400
      done(err, undefined)
    }
  })
  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 32 * 1024 * 1024, files: 5 } })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: (req) => !req.url.startsWith('/api/') })

  // Sessão + proteção CSRF (verificação de Origin em métodos de escrita)
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin as string | undefined
      const host = req.headers.host
      const sameHost = origin && host && new URL(origin).host === host
      if (origin && !sameHost && !allowedOrigin(origin)) throw forbidden('Origem da requisição não permitida.')
    }
    req.session = await resolveSession(req.cookies[SESSION_COOKIE])
    if (PUBLIC_PREFIXES.some((p) => req.url.startsWith(p))) return
    if (!req.session) throw unauthorized()
    if (req.session.mfaPending && !req.url.startsWith('/api/auth/')) throw unauthorized('Confirme o código de verificação em duas etapas.')
  })

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0]
      return reply.status(400).send({
        error: first ? `${first.path.join('.') || 'campo'}: ${first.message}` : 'Dados inválidos',
        issues: err.issues,
      })
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details })
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message })
    log().error({ err, url: req.url, method: req.method }, 'Erro não tratado na API')
    return reply.status(500).send({ error: 'Erro interno. Consulte o log do servidor.' })
  })

  // Front-end (React) servido pelo próprio servidor
  const here = dirname(fileURLToPath(import.meta.url))
  const webDist = [
    process.env.NIMBER_WEB_DIR,
    resolve(here, '..', '..', '..', 'web', 'dist'), // repo: apps/server/(src|dist)/http → apps/web/dist
    resolve(here, '..', '..', 'web'), // pacote instalado: server/dist/http → server/web
  ].find((p) => p && existsSync(join(p, 'index.html')))

  if (webDist) {
    await app.register(fstatic, { root: webDist, prefix: '/', wildcard: true, maxAge: '1h', index: false })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io')) return reply.status(404).send({ error: 'Rota não encontrada' })
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
    })
    log().info({ webDist }, 'Front-end servido pelo servidor')
  } else {
    app.get('/', async () => ({ app: 'Nimber Atende', status: 'ok', web: 'front-end não compilado (rode npm run build)' }))
  }

  return app
}
