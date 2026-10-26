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
import { runInCtx, withPlatform, type ExecCtx } from '../lib/tenant.js'
import { normalizeHost, resolveHost } from '../platform/tenants.js'
import { flowEditMode, isModuleOn, MODULES, type ModuleKey } from '../platform/modules.js'
import { forbidden, HttpError, unauthorized } from './errors.js'

declare module 'fastify' {
  interface FastifyRequest {
    session?: ResolvedSession | null
    /** cliente (subdomínio) ou plataforma (painel do fornecedor) desta requisição */
    execCtx?: ExecCtx
  }
}

/** Rotas internas atendidas em qualquer hostname, no contexto da plataforma (healthcheck do Docker, verificação do Caddy). */
const HOSTLESS_PATHS = ['/api/health', '/api/platform/tls-check']

function simplePage(title: string, text: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2937}
main{max-width:460px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#6b7280;line-height:1.5}
@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}p{color:#9ca3af}}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`
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

/** Sessão aberta pela equipe do fornecedor ("entrar como cliente")? */
export function isPlatformSession(req: FastifyRequest) {
  return !!req.session?.impersonation
}

/** Recursos que ficam só com o fornecedor: nó Código, consultas a bancos externos, compliance. */
export function requirePlatformSession(req: FastifyRequest) {
  const u = currentUser(req)
  if (!isPlatformSession(req)) throw forbidden('Recurso disponível só para a equipe do fornecedor.')
  return u
}

export function permsOf(req: FastifyRequest) {
  const u = currentUser(req)
  return effectivePermissions(u.role, u.permissions, isPlatformSession(req))
}

export function requirePermission(req: FastifyRequest, perm: 'flowsAdvanced' | 'flowsEdit' | 'kbEdit' | 'reports') {
  const u = currentUser(req)
  if (!permsOf(req)[perm]) throw forbidden()
  return u
}

/** Rotas do painel do fornecedor (hostname da plataforma). */
const PLATFORM_ROUTES = ['/api/auth/', '/api/platform/', '/api/ai/providers', '/api/ai/tasks', '/api/ai/usage', '/api/audit', '/api/brand']
/** Rotas que nunca respondem no hostname de um cliente. */
const TENANT_BLOCKED = ['/api/platform/', '/api/ai/providers', '/api/ai/tasks']

const notFoundRoute = () => new HttpError(404, 'Rota não encontrada')

/**
 * Módulos contratados e recursos do fornecedor, conferidos no servidor em cada requisição do cliente.
 * Módulo desligado = 403 (a tela some e a API recusa).
 */
function gate(req: FastifyRequest, path: string) {
  const t = req.execCtx?.kind === 'tenant' ? req.execCtx : null
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  const need = (key: ModuleKey) => {
    if (!isModuleOn(t, key)) throw forbidden(`Módulo não contratado: ${MODULES.find((m) => m.key === key)?.label ?? key}. Fale com o fornecedor do sistema.`)
  }
  if (/^\/api\/integrations\/(databases|queries|query-runs)/.test(path)) return void requirePlatformSession(req)
  if (path.startsWith('/api/integrations/webhooks')) return need('integracoes')
  if (path.startsWith('/api/ai/') || path.startsWith('/api/kb/') || /^\/api\/conversations\/[^/]+\/(suggest|handoff-card)/.test(path)) return need('ia')
  if (path.startsWith('/api/reports')) return need('relatorios')
  if (path.startsWith('/api/flows') && write) {
    need('fluxos')
    if (isPlatformSession(req) || /\/simulate$|\/validate$/.test(path)) return
    const mode = flowEditMode(t)
    const creating = (req.method === 'POST' && path === '/api/flows') || /\/duplicate$/.test(path)
    if (creating && mode !== 'cliente_cria') throw forbidden('Criar fluxos novos está liberado só para o fornecedor neste plano.')
    if (!creating && mode === 'fornecedor') throw forbidden('Os fluxos deste ambiente são mantidos pelo fornecedor.')
    return
  }
  if (path.startsWith('/api/settings/') && write) {
    const key = path.split('/')[3]
    if (key === 'compliance') return void requirePlatformSession(req)
    if (key === 'ai' || key === 'qualification' || key === 'handoff') return need('ia')
    if (key === 'notifications') return need('integracoes')
  }
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

const PUBLIC_PREFIXES = ['/api/health', '/api/setup/', '/api/auth/login', '/api/auth/2fa/verify', '/api/auth/logout', '/api/auth/impersonate', '/api/public/', '/api/brand']

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: cfg.server.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  })

  const publicOrigin = new URL(cfg.server.publicUrl).origin
  const base = cfg.server.baseDomain
  const allowedOrigin = (origin: string | undefined) => {
    if (!origin) return true
    if (origin === publicOrigin) return true
    try {
      const u = new URL(origin)
      // subdomínios dos clientes e o painel; o tempo real ainda confere se a origem é o próprio cliente
      if (u.hostname === base || u.hostname.endsWith(`.${base}`)) return true
      // ambiente de desenvolvimento do Vite
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
        // Sem HTTPS (rede interna por IP ou nome da máquina), não forçar https nos arquivos do painel:
        // o navegador tentaria https://servidor:8080 e a página ficaria em branco.
        ...(cfg.server.publicUrl.startsWith('https://') ? {} : { upgradeInsecureRequests: null }),
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

  // Cliente pelo hostname: <slug>.<BASE_DOMAIN> → schema t_<slug>. Toda a requisição roda nesse contexto.
  app.addHook('onRequest', (req, reply, done) => {
    const path = req.url.split('?')[0] ?? ''
    if (HOSTLESS_PATHS.includes(path)) {
      req.execCtx = { kind: 'platform' }
      return withPlatform(() => done())
    }
    resolveHost(req.headers.host).then(
      (r) => {
        const api = path.startsWith('/api/') || path.startsWith('/socket.io')
        if (r.kind === 'unknown') {
          if (api) return reply.status(404).send({ error: 'Endereço não encontrado.' })
          return reply
            .status(404)
            .type('text/html; charset=utf-8')
            .send(simplePage('Endereço não encontrado', `Não existe um ambiente em ${normalizeHost(req.headers.host)}. Confira o endereço com quem forneceu o seu acesso.`))
        }
        if (r.kind === 'tenant' && r.tenant.status === 'suspenso') {
          if (api) return reply.status(503).send({ error: 'Acesso suspenso. Fale com o fornecedor do sistema.' })
          return reply.status(503).type('text/html; charset=utf-8').send(simplePage('Acesso suspenso', 'Este ambiente está temporariamente suspenso. Fale com o fornecedor do sistema.'))
        }
        const ctx: ExecCtx = r.kind === 'tenant' ? r.tenant : { kind: 'platform' }
        req.execCtx = ctx
        runInCtx(ctx, () => done())
      },
      (err) => done(err),
    )
  })
  // O corpo da requisição é lido entre onRequest e preValidation: reabre o contexto por garantia.
  app.addHook('preValidation', (req, _reply, done) => {
    if (req.execCtx) return runInCtx(req.execCtx, () => done())
    done()
  })

  // Sessão + proteção CSRF (verificação de Origin em métodos de escrita)
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin as string | undefined
      if (origin) {
        let originHost: string
        try {
          originHost = new URL(origin).host
        } catch {
          throw forbidden('Origem da requisição não permitida.') // ex.: "Origin: null"
        }
        if (originHost !== req.headers.host) {
          // Subdomínios irmãos contam como o mesmo "site" para o SameSite: num cliente, só a própria origem escreve
          const devOrigin = process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1)$/.test(originHost.replace(/:\d+$/, ''))
          // (vale também para o painel do fornecedor: uma página de cliente nunca escreve no painel)
          if (!devOrigin) throw forbidden('Origem da requisição não permitida.')
        }
      }
    }
    const path = req.url.split('?')[0] ?? ''
    if (HOSTLESS_PATHS.includes(path)) return
    // Cada hostname só atende as rotas do seu lado: painel do fornecedor x ambiente do cliente
    if (req.execCtx?.kind === 'platform') {
      if (!PLATFORM_ROUTES.some((p) => path.startsWith(p))) throw notFoundRoute()
    } else if (TENANT_BLOCKED.some((p) => path.startsWith(p))) throw notFoundRoute()

    req.session = await resolveSession(req.cookies[SESSION_COOKIE])
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return
    if (!req.session) throw unauthorized()
    if (req.session.mfaPending && !path.startsWith('/api/auth/')) throw unauthorized('Confirme o código de verificação em duas etapas.')
    // Painel do fornecedor: sem 2FA ativo, só as rotas de acesso (a configuração do 2FA) funcionam
    if (req.execCtx?.kind === 'platform' && !req.session.user.totp_enabled && !path.startsWith('/api/auth/'))
      throw forbidden('Ative a verificação em duas etapas para usar o painel do fornecedor.')
    if (req.execCtx?.kind === 'tenant') gate(req, path)
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
    // Cache: a página (index.html) é sempre revalidada, para que uma atualização apareça na hora;
    // os arquivos de /assets têm o hash do conteúdo no nome e podem ficar em cache por 1 ano.
    await app.register(fstatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
      index: false,
      cacheControl: false,
      setHeaders: (reply, filePath) => {
        reply.header('Cache-Control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
    // A raiz é uma pasta: sem esta rota o plugin responde 403 em "/"
    app.get('/', (_req, reply) => reply.sendFile('index.html'))
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0] ?? ''
      if (path.startsWith('/api/') || path.startsWith('/socket.io')) return reply.status(404).send({ error: 'Rota não encontrada' })
      // Arquivo que não existe (ex.: /assets/index-antigo.js depois de uma atualização) responde 404 de verdade.
      // Devolver a página no lugar fazia o navegador receber HTML onde esperava JavaScript, e a tela ficava em branco.
      if (path.startsWith('/assets/') || /\.[a-z0-9]{1,8}$/i.test(path)) {
        return reply.status(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Arquivo não encontrado')
      }
      return reply.sendFile('index.html')
    })
    log().info({ webDist }, 'Front-end servido pelo servidor')
  } else {
    app.get('/', async () => ({ app: 'softIA', status: 'ok', web: 'front-end não compilado (rode npm run build)' }))
  }

  return app
}
