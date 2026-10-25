#!/usr/bin/env node
/**
 * Teste de isolamento entre clientes (ponta a ponta, servidor rodando).
 *
 *   1. Cria dois clientes de teste (iso-a e iso-b) se ainda não existirem.
 *   2. Confere, por HTTP e por Socket.IO, que nenhum dado ou evento de um aparece no outro.
 *
 * Uso (na pasta apps/server, com as mesmas variáveis NIMBER_DB_* do servidor):
 *   BASE_URL=http://127.0.0.1:8080 BASE_DOMAIN=localhost node scripts/test-isolation.mjs
 * O servidor precisa ter sido iniciado com o mesmo BASE_DOMAIN.
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(here, '..', '..', 'web', 'package.json'))
const { io } = require('socket.io-client')

const BASE = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:8080')
const DOMAIN = process.env.BASE_DOMAIN ?? 'localhost'
const A = { slug: 'iso-a', email: 'admin@iso-a.test', password: 'SenhaIsoA123' }
const B = { slug: 'iso-b', email: 'admin@iso-b.test', password: 'SenhaIsoB123' }
const hostOf = (t) => `${t.slug}.${DOMAIN}`

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FALHA'}  ${label}`)
  if (!cond) failures++
}

function request(method, path, { host, cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port || 80,
        method,
        path,
        headers: {
          host: host ?? BASE.host,
          ...(cookie ? { cookie } : {}),
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(method !== 'GET' ? { origin: `http://${host}${BASE.port ? `:${BASE.port}` : ''}` } : {}),
        },
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(buf)
          } catch {
            /* html */
          }
          resolve({ status: res.statusCode, json, text: buf, cookie: (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ') })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function cli(...args) {
  return execFileSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: join(here, '..'), encoding: 'utf8', env: process.env })
}

async function ensureTenant(t, name) {
  const list = cli('tenant:list')
  if (!list.split('\n').some((l) => l.startsWith(t.slug + ' '))) {
    cli('tenant:create', t.slug, '--name', name, '--admin-name', `Admin ${name}`, '--admin-email', t.email, '--password', t.password)
  }
}

async function login(t) {
  const r = await request('POST', '/api/auth/login', { host: hostOf(t), body: { email: t.email, password: t.password } })
  return r
}

function socketFor(t, cookie) {
  return io(`http://${BASE.hostname}:${BASE.port}`, {
    path: '/socket.io',
    transports: ['websocket'],
    extraHeaders: { host: hostOf(t), cookie, origin: `http://${hostOf(t)}:${BASE.port}` },
    reconnection: false,
    timeout: 4000,
  })
}

const waitConnect = (s) =>
  new Promise((resolve) => {
    s.on('connect', () => resolve(true))
    s.on('connect_error', () => resolve(false))
    setTimeout(() => resolve(false), 5000)
  })

async function main() {
  await ensureTenant(A, 'Isolamento A')
  await ensureTenant(B, 'Isolamento B')

  // ---------------------------------------------------------------- hostnames
  check((await request('GET', '/api/health', { host: 'qualquer-coisa.exemplo' })).status === 200, 'healthcheck responde em qualquer hostname')
  check((await request('GET', '/api/setup/status', { host: `nao-existe.${DOMAIN}` })).status === 404, 'subdomínio desconhecido responde 404')
  check((await request('GET', `/api/platform/tls-check?domain=${hostOf(A)}`)).status === 200, 'Caddy pode emitir certificado para um cliente')
  check((await request('GET', `/api/platform/tls-check?domain=invasor.${DOMAIN}`)).status === 404, 'Caddy não emite certificado para hostname desconhecido')

  // ---------------------------------------------------------------- login e sessão
  const la = await login(A)
  const lb = await login(B)
  check(la.status === 200 && !!la.cookie, 'admin do cliente A entra no subdomínio A')
  check(lb.status === 200 && !!lb.cookie, 'admin do cliente B entra no subdomínio B')
  const cross = await request('POST', '/api/auth/login', { host: hostOf(B), body: { email: A.email, password: A.password } })
  check(cross.status === 401, 'credenciais do cliente A não valem no subdomínio B')
  check((await request('GET', '/api/auth/me', { host: hostOf(B), cookie: la.cookie })).status === 401, 'sessão do cliente A não vale no subdomínio B')
  check((await request('GET', '/api/auth/me', { host: hostOf(A), cookie: la.cookie })).status === 200, 'sessão do cliente A vale no subdomínio A')

  // ---------------------------------------------------------------- dados
  const tagName = `so-do-A-${Date.now()}`
  const created = await request('POST', '/api/tags', { host: hostOf(A), cookie: la.cookie, body: { name: tagName, color: '#123456' } })
  check(created.status === 200, 'cliente A cria uma etiqueta')
  const tagsA = await request('GET', '/api/tags', { host: hostOf(A), cookie: la.cookie })
  const tagsB = await request('GET', '/api/tags', { host: hostOf(B), cookie: lb.cookie })
  check(JSON.stringify(tagsA.json).includes(tagName), 'a etiqueta aparece no cliente A')
  check(!JSON.stringify(tagsB.json).includes(tagName), 'a etiqueta NÃO aparece no cliente B')

  // ---------------------------------------------------------------- tempo real
  const sa = socketFor(A, la.cookie)
  const sb = socketFor(B, lb.cookie)
  const sx = socketFor(B, la.cookie) // cookie de A no hostname de B
  check(await waitConnect(sa), 'socket do cliente A conecta')
  check(await waitConnect(sb), 'socket do cliente B conecta')
  check(!(await waitConnect(sx)), 'socket com a sessão de A no hostname de B é recusado')

  const seenByB = []
  const seenByA = []
  sb.onAny((ev, data) => seenByB.push([ev, data]))
  sa.onAny((ev, data) => seenByA.push([ev, data]))
  // Mudar a presença do admin A emite "user:presence" para a equipe do cliente A
  sa.emit('presence', 'away')
  await new Promise((r) => setTimeout(r, 1200))
  check(seenByA.some(([ev]) => ev === 'user:presence'), 'evento de tempo real chega à equipe do cliente A')
  check(!seenByB.some(([ev]) => ev === 'user:presence'), 'evento de tempo real do cliente A NÃO chega ao cliente B')
  sa.close()
  sb.close()
  sx.close()

  console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nIsolamento entre clientes: todas as verificações passaram.')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
