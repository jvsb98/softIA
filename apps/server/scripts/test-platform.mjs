#!/usr/bin/env node
/**
 * Teste ponta a ponta do painel do fornecedor (servidor rodando, build em dist/).
 *
 *   - login da equipe com 2FA obrigatório;
 *   - criação de cliente pelo painel, módulos e limites conferidos no servidor;
 *   - "entrar como cliente" com token de uso único e recursos que ficam só com o fornecedor;
 *   - marca do cliente, escopo das rotas por hostname e suspensão.
 *
 * Uso (na pasta apps/server, com as mesmas variáveis NIMBER_DB_* do servidor):
 *   BASE_URL=http://127.0.0.1:8080 BASE_DOMAIN=localhost node scripts/test-platform.mjs
 */
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const { totp } = await import(join(root, 'dist', 'auth', 'totp.js'))

const BASE = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:8080')
const DOMAIN = process.env.BASE_DOMAIN ?? 'localhost'
const PANEL = process.env.PLATFORM_HOST ?? `painel.${DOMAIN}`
const STAMP = Date.now().toString(36)
const SLUG = `plat-${STAMP}`
const ADMIN = { email: `admin-${STAMP}@fornecedor.test`, password: 'SenhaFornecedor123' }

let failures = 0
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FALHA'}  ${label}`)
  if (!cond) failures++
}

function request(method, path, { host = PANEL, cookie, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const hostHeader = `${host}${BASE.port ? `:${BASE.port}` : ''}`
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port || 80,
        method,
        path,
        headers: {
          host: hostHeader,
          ...(cookie ? { cookie } : {}),
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
          ...(method !== 'GET' ? { origin: `http://${hostHeader}` } : {}),
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
          resolve({ status: res.statusCode, json, headers: res.headers, cookie: (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ') })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function upload(path, cookie, filename, mime, content) {
  const boundary = `----softia${Date.now()}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`)
  const body = Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)])
  const hostHeader = `${PANEL}${BASE.port ? `:${BASE.port}` : ''}`
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: BASE.hostname,
        port: BASE.port || 80,
        method: 'POST',
        path,
        headers: { host: hostHeader, cookie, origin: `http://${hostHeader}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const cli = (...a) => execFileSync('node', ['dist/cli.js', ...a], { cwd: root, encoding: 'utf8', env: process.env })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function staffLogin(email, password) {
  const l = await request('POST', '/api/auth/login', { body: { email, password } })
  return l
}

async function enable2fa(cookie) {
  const s = await request('POST', '/api/auth/2fa/setup', { cookie })
  const c = await request('POST', '/api/auth/2fa/confirm', { cookie, body: { code: totp(s.json.secret) } })
  return { ok: c.status === 200, secret: s.json?.secret }
}

async function main() {
  // ---------------------------------------------------------------- equipe do fornecedor e 2FA
  cli('platform:create-admin', '--name', 'Admin Teste', '--email', ADMIN.email, '--password', ADMIN.password)
  const l = await staffLogin(ADMIN.email, ADMIN.password)
  check(l.status === 200 && l.json?.mfaSetupRequired === true, 'super admin entra no painel e o 2FA é exigido')
  const pc = l.cookie
  check((await request('GET', '/api/platform/tenants', { cookie: pc })).status === 403, 'sem 2FA ativo, a API do painel recusa')
  check((await request('POST', '/api/setup/admin', { body: { name: 'x', email: 'x@x.com', password: 'x' } })).status === 404, 'o painel não tem tela de primeira instalação pela web')
  check((await enable2fa(pc)).ok, '2FA ativado com o código do aplicativo')
  const list0 = await request('GET', '/api/platform/tenants', { cookie: pc })
  check(list0.status === 200 && Array.isArray(list0.json), 'com 2FA, a lista de clientes abre')

  // ---------------------------------------------------------------- criar cliente (plano essencial)
  const sc = await request('GET', `/api/platform/slug-check?slug=${SLUG}`, { cookie: pc })
  check(sc.json?.ok === true, 'endereço livre confirmado na hora')
  check((await request('GET', '/api/platform/slug-check?slug=painel', { cookie: pc })).json?.ok === false, 'endereço reservado é recusado')
  const created = await request('POST', '/api/platform/tenants', {
    cookie: pc,
    body: {
      name: 'Marmoraria Teste',
      slug: SLUG,
      segment: 'marmoraria',
      plan: 'essencial',
      brand: { productName: 'Atende Pedra', primaryColor: '#1D4ED8' },
      admin: { name: 'Dona Teste', email: `dona@${SLUG}.test` },
    },
  })
  check(created.status === 200 && !!created.json?.temporaryPassword, 'cliente criado pelo painel com senha temporária')
  check(String(created.json?.whatsappMessage ?? '').includes(created.json?.url ?? '?'), 'mensagem pronta para WhatsApp com endereço e senha')
  const tenantId = created.json?.id
  const TH = `${SLUG}.${DOMAIN}`
  await sleep(300)

  // ---------------------------------------------------------------- módulos e limites no cliente
  const tl = await request('POST', '/api/auth/login', { host: TH, body: { email: `dona@${SLUG}.test`, password: created.json.temporaryPassword } })
  check(tl.status === 200, 'administrador do cliente entra com a senha temporária')
  const tc = tl.cookie
  const me = await request('GET', '/api/auth/me', { host: TH, cookie: tc })
  check(me.json?.scope === 'tenant' && me.json?.modules?.ia?.on === false && me.json?.modules?.fluxos?.on === true, 'plano essencial: fluxos ligado, IA desligada')
  check((await request('GET', '/api/kb/documents', { host: TH, cookie: tc })).status === 403, 'IA desligada: base de conhecimento recusada (403)')
  check((await request('POST', '/api/flows', { host: TH, cookie: tc, body: { name: 'Teste' } })).status === 403, 'plano essencial: o cliente não cria fluxos')
  check(
    (await request('POST', '/api/integrations/databases', { host: TH, cookie: tc, body: { name: 'x' } })).status === 403,
    'consulta a banco externo fica só com o fornecedor',
  )
  check((await request('PUT', '/api/settings/compliance', { host: TH, cookie: tc, body: { guardEnabled: true } })).status === 403, 'compliance fica só com o fornecedor')
  // Caminho com letras codificadas (%66 = f) chega ao mesmo handler: as regras valem igual
  check((await request('POST', '/api/integrations/%64atabases', { host: TH, cookie: tc, body: { name: 'x' } })).status === 403, 'caminho codificado não escapa da trava de banco externo')
  check((await request('PUT', '/api/settings/%63ompliance', { host: TH, cookie: tc, body: { guardEnabled: true } })).status === 403, 'caminho codificado não escapa da trava de compliance')
  check((await request('POST', '/api/%66lows', { host: TH, cookie: tc, body: { name: 'Teste' } })).status === 403, 'caminho codificado não escapa do modo de edição de fluxos')
  check((await request('GET', '/api/integrations/%77ebhooks', { host: TH, cookie: tc })).status === 403, 'caminho codificado não escapa do módulo Integrações')
  check((await request('GET', '/%61pi/platform/tenants', { host: TH, cookie: tc })).status === 404, 'caminho codificado não abre rota do painel no cliente')
  const c1 = await request('POST', '/api/connections', { host: TH, cookie: tc, body: { name: 'Número 1' } })
  const c2 = await request('POST', '/api/connections', { host: TH, cookie: tc, body: { name: 'Número 2' } })
  check(c1.status === 200 && c2.status === 400, 'limite de números de WhatsApp do plano (1) conferido')
  const u1 = await request('POST', '/api/users', { host: TH, cookie: tc, body: { name: 'Atendente Um', email: `u1@${SLUG}.test`, role: 'agent' } })
  const u2 = await request('POST', '/api/users', { host: TH, cookie: tc, body: { name: 'Atendente Dois', email: `u2@${SLUG}.test`, role: 'agent' } })
  const u3 = await request('POST', '/api/users', { host: TH, cookie: tc, body: { name: 'Atendente Três', email: `u3@${SLUG}.test`, role: 'agent' } })
  check(u1.status === 200 && u2.status === 200 && u3.status === 400, 'limite de usuários do plano (3) conferido')

  // ---------------------------------------------------------------- fornecedor liga módulos
  const mods = await request('PUT', `/api/platform/tenants/${tenantId}/modules`, {
    cookie: pc,
    body: { modules: { ia: { enabled: true, config: {} }, fluxos: { enabled: true, config: { edicao: 'cliente_cria' } } } },
  })
  check(mods.status === 200, 'fornecedor liga a IA e libera o cliente para criar fluxos')
  await sleep(300)
  check((await request('GET', '/api/kb/documents', { host: TH, cookie: tc })).status === 200, 'IA ligada: base de conhecimento abre na hora')
  check((await request('POST', '/api/flows', { host: TH, cookie: tc, body: { name: 'Fluxo do cliente' } })).status === 200, 'cliente agora cria fluxos')

  // ---------------------------------------------------------------- marca
  const brand = await request('GET', '/api/brand', { host: TH })
  check(brand.json?.productName === 'Atende Pedra' && brand.json?.primaryColor === '#1D4ED8', 'marca do cliente aplicada no subdomínio dele')
  check((await request('GET', '/api/brand')).json?.scope === 'platform', 'painel tem a marca do fornecedor')
  const fake = await upload(`/api/platform/tenants/${tenantId}/brand/logo`, pc, 'logo.png', 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  check(fake.status === 400, 'logo falso (SVG com tipo PNG) é recusado pelo conteúdo')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  check((await upload(`/api/platform/tenants/${tenantId}/brand/logo`, pc, 'logo.png', 'image/png', png)).status === 200, 'logo PNG de verdade é aceito')
  await request('PUT', `/api/platform/tenants/${tenantId}/brand`, { cookie: pc, body: { productName: '', primaryColor: '' } })
  await sleep(300)
  const cleared = await request('GET', '/api/brand', { host: TH })
  check(cleared.json?.productName === 'Marmoraria Teste' && !cleared.json?.primaryColor, 'marca limpa volta ao nome da empresa e à cor padrão')

  // ---------------------------------------------------------------- escopo das rotas
  check((await request('GET', '/api/platform/tenants', { host: TH, cookie: tc })).status === 404, 'rota do painel não existe no hostname do cliente')
  check((await request('GET', '/api/conversations', { cookie: pc })).status === 404, 'rota do cliente não existe no painel')
  check((await request('GET', '/api/ai/providers', { host: TH, cookie: tc })).status === 404, 'provedores de IA não aparecem para o cliente')
  check((await request('GET', '/api/ai/providers', { cookie: pc })).status === 200, 'provedores de IA ficam no painel do fornecedor')

  // ---------------------------------------------------------------- entrar como cliente
  const imp = await request('POST', `/api/platform/tenants/${tenantId}/impersonate`, { cookie: pc, body: { reason: 'Implantação inicial' } })
  check(imp.status === 200 && String(imp.json?.url ?? '').includes(TH), 'link de acesso gerado para o subdomínio do cliente')
  const path = new URL(imp.json.url).pathname + new URL(imp.json.url).search
  const go = await request('GET', path, { host: TH })
  check(go.status === 302 && !!go.cookie, 'link abre uma sessão no cliente')
  const again = await request('GET', path, { host: TH })
  check(again.status === 403, 'o mesmo link não vale duas vezes')
  const ic = go.cookie
  const ime = await request('GET', '/api/auth/me', { host: TH, cookie: ic })
  check(ime.json?.impersonation?.byName === 'Admin Teste' && ime.json?.user?.permissions?.flowsAdvanced === true, 'sessão do fornecedor identificada, com nós avançados liberados')
  const exp = Date.parse(ime.json?.impersonation?.expiresAt ?? '') - Date.now()
  check(exp > 0 && exp <= 2 * 3600_000 + 5000, 'sessão do fornecedor vale no máximo 2 horas')
  check((await request('PUT', '/api/settings/compliance', { host: TH, cookie: ic, body: { guardEnabled: false } })).status === 200, 'fornecedor ajusta o compliance dentro do cliente')
  const users = await request('GET', '/api/users', { host: TH, cookie: tc })
  check(Array.isArray(users.json) && !users.json.some((u) => String(u.email).includes('@acesso.invalid')), 'acesso técnico do fornecedor não aparece na lista de usuários')
  const imp2 = await request('POST', `/api/platform/tenants/${tenantId}/impersonate`, { host: TH, cookie: tc, body: {} })
  check(imp2.status === 404, 'cliente não consegue gerar link de acesso do fornecedor')

  // ---------------------------------------------------------------- perfil Suporte
  const sup = await request('POST', '/api/platform/team', { cookie: pc, body: { name: 'Suporte Teste', email: `sup-${STAMP}@fornecedor.test`, role: 'suporte' } })
  check(sup.status === 200, 'super admin cadastra alguém do suporte')
  const sl = await staffLogin(`sup-${STAMP}@fornecedor.test`, sup.json.temporaryPassword)
  await enable2fa(sl.cookie)
  const noReason = await request('POST', `/api/platform/tenants/${tenantId}/impersonate`, { cookie: sl.cookie, body: { reason: '' } })
  check(noReason.status === 400, 'suporte precisa informar o motivo para entrar no cliente')
  const supCreate = await request('POST', '/api/platform/tenants', { cookie: sl.cookie, body: { name: 'X', slug: `x-${STAMP}`, admin: { name: 'X', email: 'x@x.test' } } })
  check(supCreate.status === 403, 'suporte não cria clientes')
  const supStatus = await request('POST', `/api/platform/tenants/${tenantId}/status`, { cookie: sl.cookie, body: { status: 'suspenso' } })
  check(supStatus.status === 403, 'suporte não suspende clientes')
  const supImp = await request('POST', `/api/platform/tenants/${tenantId}/impersonate`, { cookie: sl.cookie, body: { reason: 'Cliente pediu ajuda' } })
  const supGo = await request('GET', new URL(supImp.json.url).pathname + new URL(supImp.json.url).search, { host: TH })
  check((await request('GET', '/api/auth/me', { host: TH, cookie: supGo.cookie })).status === 200, 'suporte entra no cliente informando o motivo')
  const dup = await request('PUT', `/api/platform/team/${sup.json.id}`, { cookie: pc, body: { name: 'Suporte Teste', email: ADMIN.email, role: 'suporte', active: true } })
  check(dup.status === 400, 'e-mail repetido na equipe é recusado com mensagem')
  await request('PUT', `/api/platform/team/${sup.json.id}`, { cookie: pc, body: { name: 'Suporte Teste', email: `sup-${STAMP}@fornecedor.test`, role: 'suporte', active: false } })
  check((await request('GET', '/api/auth/me', { host: TH, cookie: supGo.cookie })).status === 401, 'pessoa desativada perde na hora o acesso que tinha aberto no cliente')

  // ---------------------------------------------------------------- situação
  await request('POST', `/api/platform/tenants/${tenantId}/status`, { cookie: pc, body: { status: 'suspenso' } })
  await sleep(500)
  check((await request('GET', '/api/auth/me', { host: TH, cookie: tc })).status === 503, 'cliente suspenso pelo painel responde 503')
  await request('POST', `/api/platform/tenants/${tenantId}/status`, { cookie: pc, body: { status: 'ativo' } })
  await sleep(500)
  check((await request('GET', '/api/auth/me', { host: TH, cookie: tc })).status === 200, 'cliente reativado volta a funcionar')
  const detail = await request('GET', `/api/platform/tenants/${tenantId}`, { cookie: pc })
  check(detail.status === 200 && detail.json?.recentActivity?.some((a) => a.action === 'fornecedor.acesso_iniciado'), 'ficha do cliente mostra o acesso do fornecedor na atividade')
  const audit = await request('GET', '/api/audit?action=cliente.', { cookie: pc })
  check(Array.isArray(audit.json) && audit.json.some((a) => a.action === 'cliente.acesso_fornecedor'), 'auditoria da plataforma registra quem entrou e por quê')

  console.log(failures ? `\n${failures} verificação(ões) falharam.` : '\nPainel do fornecedor: todas as verificações passaram.')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
