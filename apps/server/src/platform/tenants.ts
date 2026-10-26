/**
 * Registro de clientes (schema plataforma): resolução pelo hostname e criação de um cliente novo.
 */
import { randomToken } from '../lib/crypto.js'
import { loadConfig } from '../lib/config.js'
import { db, migrateTenant, one, q, tx } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { schemaForSlug, SLUG_RE, withPlatform, withTenant, type TenantCtx } from '../lib/tenant.js'
import { publishPlatformEvent } from './events.js'
import { DEFAULT_LIMITS, MODULES, PLAN_PRESETS, type ModuleState, type TenantLimits } from './modules.js'

/** Colunas do cliente + módulos ligados (um JSON por módulo), para montar o contexto. */
const TENANT_COLS = `t.id, t.slug, t.schema_name, t.name, t.status, t.limits,
  coalesce((SELECT jsonb_object_agg(m.module, jsonb_build_object('enabled', m.enabled, 'config', m.config))
              FROM tenant_modules m WHERE m.tenant_id = t.id), '{}'::jsonb) AS modules`

/** Subdomínios que nunca viram cliente. */
export const RESERVED_SLUGS = new Set([
  'www', 'app', 'api', 'painel', 'admin', 'mail', 'smtp', 'imap', 'pop', 'webmail', 'suporte', 'status',
  'static', 'assets', 'cdn', 'ftp', 'ns1', 'ns2', 'dev', 'teste', 'test', 'staging', 'docs', 'blog',
])

export type HostResolution = { kind: 'tenant'; tenant: TenantCtx } | { kind: 'platform' } | { kind: 'unknown' }

const cache = new Map<string, { v: HostResolution; at: number }>()
const TTL = 60_000
const MAX_CACHE = 5_000 // hostnames aleatórios (varredura) não podem crescer o cache sem limite

/** "Clinica.Exemplo.com:443." → "clinica.exemplo.com" */
export function normalizeHost(h: string | undefined | null): string {
  let s = String(h ?? '').trim().toLowerCase()
  if (s.startsWith('[')) return s // IPv6 literal: nunca é cliente
  s = s.replace(/:\d+$/, '').replace(/\.$/, '')
  return s
}

export function tenantFromRow(r: any): TenantCtx {
  return { kind: 'tenant', id: r.id, slug: r.slug, schema: r.schema_name, name: r.name, status: r.status, modules: r.modules ?? {}, limits: r.limits ?? {} }
}

export async function resolveHost(hostHeader: string | undefined | null): Promise<HostResolution> {
  const host = normalizeHost(hostHeader)
  if (!host) return { kind: 'unknown' }
  if (host === loadConfig().server.platformHost) return { kind: 'platform' }
  const c = cache.get(host)
  // Hostname desconhecido fica pouco tempo em cache: um cliente recém-criado aparece em segundos
  if (c && Date.now() - c.at < (c.v.kind === 'unknown' ? 5_000 : TTL)) return c.v
  const row = await withPlatform(() =>
    one<any>(
      `SELECT ${TENANT_COLS} FROM domains d JOIN tenants t ON t.id = d.tenant_id
        WHERE d.hostname = $1 AND t.status <> 'cancelado'`,
      [host],
    ),
  )
  const v: HostResolution = row ? { kind: 'tenant', tenant: tenantFromRow(row) } : { kind: 'unknown' }
  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(host, { v, at: Date.now() })
  return v
}

/** Esquece o cache (ao suspender, reativar ou mudar domínios de um cliente). */
export function invalidateHosts() {
  cache.clear()
  byId.clear()
}

/** O hostname existe? (usado pelo Caddy antes de emitir um certificado) */
export async function isKnownHost(hostname: string): Promise<boolean> {
  const r = await resolveHost(hostname)
  return r.kind !== 'unknown'
}

export async function getTenant(idOrSlug: string): Promise<TenantCtx | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug)
  const row = await withPlatform(() =>
    one<any>(`SELECT ${TENANT_COLS} FROM tenants t WHERE t.${isUuid ? 'id' : 'slug'} = $1`, [idOrSlug]),
  )
  return row ? tenantFromRow(row) : null
}

const byId = new Map<string, { t: TenantCtx | null; at: number }>()
/** getTenant com cache de 30 s (a fila de tarefas consulta a cada execução). */
export async function getTenantCached(id: string): Promise<TenantCtx | null> {
  const c = byId.get(id)
  if (c && Date.now() - c.at < 30_000) return c.t
  const t = await getTenant(id)
  byId.set(id, { t, at: Date.now() })
  return t
}

/** Clientes que o servidor deve atender (conexões de WhatsApp, tarefas): implantação e ativos. */
export async function listRunningTenants(): Promise<TenantCtx[]> {
  const rows = await withPlatform(() =>
    q<any>(`SELECT ${TENANT_COLS} FROM tenants t WHERE t.status IN ('implantacao','ativo') ORDER BY t.created_at`),
  )
  return rows.map(tenantFromRow)
}

/** Endereço público de um cliente, com o mesmo esquema e porta do PUBLIC_URL (https em produção). */
export function tenantUrl(slug: string): string {
  const cfg = loadConfig().server
  const u = new URL(cfg.publicUrl)
  return `${u.protocol}//${slug}.${cfg.baseDomain}${u.port ? `:${u.port}` : ''}`
}

export interface CreateTenantInput {
  slug: string
  name: string
  segment?: string | null
  adminName: string
  adminEmail: string
  /** sem senha: gera uma temporária, trocada no primeiro acesso */
  adminPassword?: string
  /** plano de referência (essencial, profissional, completo): preenche módulos e limites */
  plan?: string | null
  /** módulos ligados (sobrepõe o plano) */
  modules?: Partial<Record<string, ModuleState>>
  /** limites (sobrepõe o plano) */
  limits?: Partial<TenantLimits>
  /** marca: nome do produto e cor principal */
  brand?: { productName?: string; primaryColor?: string }
  contact?: Record<string, any>
  notes?: string | null
  /** pessoa da equipe do fornecedor que criou (auditoria) */
  createdBy?: string | null
}

export interface CreateTenantResult {
  tenant: TenantCtx
  url: string
  adminEmail: string
  temporaryPassword: string | null
}

export function validateSlug(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return 'Use de 1 a 40 letras minúsculas, números ou hífen, sem hífen no começo ou no fim.'
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" é um endereço reservado.`
  return null
}

/**
 * Cria um cliente: registro na plataforma, subdomínio, schema com todas as migrações e o administrador.
 * Se algo falhar no meio, desfaz o que criou para a operação poder ser repetida.
 */
export async function createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
  const slug = input.slug.trim().toLowerCase()
  const err = validateSlug(slug)
  if (err) throw new Error(err)
  const schema = schemaForSlug(slug)
  const host = `${slug}.${loadConfig().server.baseDomain}`

  const row = await withPlatform(async () => {
    const exists = await one(`SELECT 1 FROM tenants WHERE slug=$1 OR schema_name=$2`, [slug, schema])
    if (exists) throw new Error(`Já existe um cliente com o endereço "${slug}".`)
    const taken = await one(`SELECT 1 FROM domains WHERE hostname=$1`, [host])
    if (taken) throw new Error(`O endereço ${host} já está em uso.`)
    // Um schema que sobrou (cliente apagado à mão, restauração) nunca é reaproveitado
    const leftover = await one(`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema])
    if (leftover) throw new Error(`O schema ${schema} já existe no banco. Remova-o (ou use outro endereço) antes de criar o cliente.`)
    const preset = PLAN_PRESETS.find((p) => p.key === (input.plan ?? 'essencial')) ?? PLAN_PRESETS[0]!
    const limits = { ...DEFAULT_LIMITS, ...preset.limits, ...(input.limits ?? {}) }
    const modules = { ...preset.modules, ...(input.modules ?? {}) }
    return tx(async (c) => {
      const t = (
        await c.query(
          `INSERT INTO tenants(slug, name, schema_name, segment, plan, limits, brand, contact, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [slug, input.name.trim(), schema, input.segment ?? null, preset.key, JSON.stringify(limits), JSON.stringify(input.brand ?? {}), JSON.stringify(input.contact ?? {}), input.notes ?? null, input.createdBy ?? null],
        )
      ).rows[0]
      await c.query(`INSERT INTO domains(hostname, tenant_id, kind) VALUES ($1,$2,'subdominio')`, [host, t.id])
      for (const def of MODULES) {
        const m = modules[def.key as keyof typeof modules]
        if (!def.base && m) await c.query(`INSERT INTO tenant_modules(tenant_id, module, enabled, config, updated_by) VALUES ($1,$2,$3,$4,$5)`, [t.id, def.key, m.enabled, JSON.stringify(m.config ?? {}), input.createdBy ?? null])
      }
      return (await c.query(`SELECT ${TENANT_COLS} FROM tenants t WHERE t.id=$1`, [t.id])).rows[0]
    })
  })
  const tenant = tenantFromRow(row)

  let schemaCreated = false
  try {
    await migrateTenant(tenant, { create: true })
    schemaCreated = true
    const temp = input.adminPassword ? null : `Temp-${randomToken(6)}1`
    const { hashPassword } = await import('../auth/service.js')
    const hash = await hashPassword(input.adminPassword ?? temp!)
    await withTenant(tenant, async () => {
      const u = await one<any>(
        `INSERT INTO users(name, email, password_hash, role, color, must_change_password)
         VALUES ($1,$2,$3,'admin','#FE5A51',$4) RETURNING id`,
        [input.adminName.trim(), input.adminEmail.trim().toLowerCase(), hash, !!temp],
      )
      await q(`INSERT INTO sector_members(sector_id, user_id) SELECT id, $1 FROM sectors WHERE active ON CONFLICT DO NOTHING`, [u.id])
      await q(`UPDATE settings SET value = jsonb_set(value, '{name}', to_jsonb($1::text)) WHERE key='org'`, [tenant.name])
    })
    invalidateHosts()
    await publishPlatformEvent({ type: 'tenant.created', tenantId: tenant.id })
    log().info({ tenant: slug }, 'Cliente criado')
    return { tenant, url: tenantUrl(slug), adminEmail: input.adminEmail.trim().toLowerCase(), temporaryPassword: temp }
  } catch (e) {
    log().error({ err: e, tenant: slug }, 'Falha ao criar cliente; desfazendo')
    // Primeiro o registro (o domínio cai junto): o hostname deixa de apontar para o schema
    await withPlatform(() => q(`DELETE FROM tenants WHERE id=$1`, [tenant.id])).catch((err) =>
      log().error({ err, tenant: slug }, 'Rollback: não foi possível apagar o registro do cliente'),
    )
    invalidateHosts()
    // Só apaga o schema se ele foi criado por esta operação (migrateTenant com create também pode ter criado e falhado depois)
    // O schema não existia antes (conferido acima) e o slug está travado pelo registro: se existe agora, foi criado aqui
    const created = schemaCreated || !!(await withPlatform(() => one(`SELECT 1 FROM pg_namespace WHERE nspname=$1`, [schema])).catch(() => null))
    if (created) {
      await db().query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch((err) =>
        log().error({ err, schema }, 'Rollback: não foi possível apagar o schema; remova-o manualmente'),
      )
    }
    throw e
  }
}

/** Muda a situação de um cliente (implantacao, ativo, suspenso, cancelado). */
export async function setTenantStatus(id: string, status: 'implantacao' | 'ativo' | 'suspenso' | 'cancelado') {
  await withPlatform(() => q(`UPDATE tenants SET status=$2, updated_at=now() WHERE id=$1`, [id, status]))
  invalidateHosts()
  // Os servidores rodando param (ou retomam) as conexões e sockets desse cliente na hora
  await publishPlatformEvent({ type: 'tenant.status', tenantId: id, status })
}
