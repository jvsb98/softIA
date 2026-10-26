import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { DatabaseConfig } from './config.js'
import { log } from './logger.js'
import { currentCtx, NoContextError, withPlatform, withTenant, type ExecCtx, type TenantCtx } from './tenant.js'

const { Pool, types } = pg

// BIGINT (count, sum) como número; NUMERIC como número; datas como string ISO.
types.setTypeParser(20, (v) => Number(v))
types.setTypeParser(1700, (v) => Number(v))

export type Db = pg.Pool
export type Tx = pg.PoolClient
export type Queryable = pg.Pool | pg.PoolClient

/** Schema da camada do fornecedor. */
export const PLATFORM_SCHEMA = 'plataforma'

let pool: pg.Pool | null = null

export const capabilities = { vector: false, unaccent: false, trgm: false }

/**
 * Schemas onde as extensões estão instaladas (public num Postgres comum, "extensions" no Supabase).
 * Entram no fim do search_path de todo contexto para os tipos e funções delas (vector, unaccent...) resolverem.
 */
let extPath = 'pg_catalog'

export function createPool(cfg: DatabaseConfig): pg.Pool {
  // O SET search_path vale para a sessão: num pooler em modo transação (Supabase porta 6543, PgBouncer
  // transaction) a consulta seguinte pode cair em outra sessão, com o schema de OUTRO cliente.
  if (cfg.port === 6543 || (process.env.NIMBER_DB_POOL_MODE ?? '').toLowerCase() === 'transaction') {
    throw new Error(
      'Conexão por pooler em modo transação (porta 6543) não é suportada: use o pooler em modo SESSÃO (porta 5432) ou a conexão direta.',
    )
  }
  pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.poolMax,
    ssl: cfg.ssl === false ? false : { rejectUnauthorized: cfg.ssl === true, ca: cfg.sslCa },
    application_name: 'softia',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', (err) => log().error({ err: { message: err.message, code: (err as any).code } }, 'Erro inesperado no pool do PostgreSQL'))
  return pool
}

/** Pool bruto. Só para LISTEN/NOTIFY e travas: consultas de dados passam por q/one/tx (com contexto). */
export function db(): pg.Pool {
  if (!pool) throw new Error('Banco não inicializado')
  return pool
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`

function searchPathFor(ctx: ExecCtx): string {
  return ctx.kind === 'tenant' ? `${ident(ctx.schema)}, ${extPath}` : `${ident(PLATFORM_SCHEMA)}, ${extPath}`
}

type TaggedClient = pg.PoolClient & { __sp?: string }

/**
 * Pega uma conexão do pool já apontada para o schema do contexto atual.
 * O search_path só é trocado quando a conexão veio de outro cliente: o custo extra é raro.
 * Exige o pooler do Supabase em modo SESSÃO (ou conexão direta) — o modo transação perderia o SET.
 */
async function acquire(): Promise<TaggedClient> {
  const ctx = currentCtx()
  if (!ctx) throw new NoContextError()
  const c = (await db().connect()) as TaggedClient
  const sp = searchPathFor(ctx)
  if (c.__sp !== sp) {
    try {
      await c.query(`SET search_path TO ${sp}`)
      c.__sp = sp
    } catch (err) {
      c.release(err as Error)
      throw err
    }
  }
  return c
}

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T[]> {
  if (client && client !== pool) return (await client.query<T>(sql, params as any[])).rows
  const c = await acquire()
  try {
    return (await c.query<T>(sql, params as any[])).rows
  } finally {
    c.release()
  }
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], client?: Queryable): Promise<T | null> {
  const rows = await q<T>(sql, params, client)
  return rows[0] ?? null
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await acquire()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

// ---------------------------------------------------------------- migrações

function migrationsDir(kind: 'platform' | 'tenant'): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dev: src/lib → ../../migrations · build: dist/lib → ../migrations
  for (const p of [join(here, '..', '..', 'migrations', kind), join(here, '..', 'migrations', kind)]) {
    if (existsSync(p)) return p
  }
  throw new Error(`Pasta de migrações "${kind}" não encontrada`)
}

/**
 * Schema onde novas extensões são criadas: sempre "extensions" (já existe no Supabase; criado aqui num
 * Postgres comum). Assim o "public" não precisa entrar no search_path dos clientes.
 */
async function extensionTargetSchema(): Promise<string> {
  await db().query(`CREATE SCHEMA IF NOT EXISTS extensions`)
  return 'extensions'
}

/**
 * Trava de segurança: se "public" entrar no search_path (alguma extensão já instalada lá) e tiver
 * tabelas, uma tabela que falte no schema do cliente cairia nos dados de "public". Nesse caso o
 * servidor não sobe. Use um banco vazio (ou SOFTIA_ALLOW_PUBLIC_TABLES=true, por sua conta).
 */
async function assertPublicIsSafe() {
  if (!extPath.split(', ').includes('public')) return
  if ((process.env.SOFTIA_ALLOW_PUBLIC_TABLES ?? '').toLowerCase() === 'true') return
  const r = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')`,
  )
  if ((r?.n ?? 0) > 0) {
    throw new Error(
      `O schema "public" deste banco tem ${r!.n} tabela(s) e está no caminho de busca por causa de extensões instaladas nele. ` +
        'Use um banco vazio para o softIA (ou mova as extensões para o schema "extensions").',
    )
  }
}

async function tryExtension(name: string, schema: string): Promise<boolean> {
  try {
    await q(`CREATE EXTENSION IF NOT EXISTS ${name} SCHEMA ${ident(schema)}`)
    return true
  } catch {
    const r = await one<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS ok`, [name])
    return !!r?.ok
  }
}

/** Aplica os arquivos .sql pendentes de uma pasta no schema do contexto atual (cada arquivo numa transação). */
async function applyFolder(kind: 'platform' | 'tenant', label: string): Promise<string[]> {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)
  const done = new Set((await q<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name))
  const dir = migrationsDir(kind)
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    const sql = readFileSync(join(dir, f), 'utf8')
    await tx(async (c) => {
      await c.query(sql)
      await c.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [f])
    })
    applied.push(`${label}/${f}`)
    log().info({ migration: f, schema: label }, 'Migração aplicada')
  }
  return applied
}

/** Prepara o schema plataforma e detecta as extensões (pgvector, unaccent, pg_trgm). */
export async function migratePlatform(): Promise<string[]> {
  return withPlatform(async () => {
    await db().query(`CREATE SCHEMA IF NOT EXISTS ${ident(PLATFORM_SCHEMA)}`)
    const target = await extensionTargetSchema()
    capabilities.unaccent = await tryExtension('unaccent', target)
    capabilities.trgm = await tryExtension('pg_trgm', target)
    capabilities.vector = await tryExtension('vector', target)
    await tryExtension('pgcrypto', target)
    await refreshExtPath()
    await assertPublicIsSafe()
    return applyFolder('platform', PLATFORM_SCHEMA)
  })
}

/** Lê onde as extensões estão instaladas (sem criar nada). Usado por comandos que não migram. */
export async function refreshExtPath(): Promise<void> {
  await withPlatform(async () => {
    const ns = await q<{ nspname: string; extname: string }>(
      `SELECT n.nspname, e.extname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname IN ('unaccent','pg_trgm','vector','pgcrypto')`,
    )
    capabilities.unaccent = ns.some((r) => r.extname === 'unaccent')
    capabilities.trgm = ns.some((r) => r.extname === 'pg_trgm')
    capabilities.vector = ns.some((r) => r.extname === 'vector')
    // "public" só entra no caminho se alguma das extensões estiver instalada lá
    const schemas = [...new Set(ns.map((r) => r.nspname))].sort((a, b) => (a === 'public' ? 1 : b === 'public' ? -1 : a.localeCompare(b)))
    extPath = schemas.length ? schemas.map((n) => (n === 'public' ? 'public' : ident(n))).join(', ') : 'pg_catalog'
  })
}

/** Cria (se preciso) e atualiza o schema de um cliente. */
export async function migrateTenant(t: TenantCtx, opts: { create?: boolean } = {}): Promise<string[]> {
  if (!/^t_[a-z0-9_]{1,40}$/.test(t.schema)) throw new Error(`Schema de cliente inválido: ${t.schema}`)
  return withTenant(t, async () => {
    // Na criação, o schema NÃO pode existir (nunca reaproveitar dados que sobraram de outro cliente)
    await db().query(opts.create ? `CREATE SCHEMA ${ident(t.schema)}` : `CREATE SCHEMA IF NOT EXISTS ${ident(t.schema)}`)
    // Função de normalização usada na busca textual (com ou sem unaccent), criada dentro do schema do cliente.
    const ua = capabilities.unaccent
      ? await one<{ ns: string }>(`SELECT quote_ident(n.nspname) AS ns FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent'`)
      : null
    await q(
      ua
        ? `CREATE OR REPLACE FUNCTION na_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(${ua.ns}.unaccent('${ua.ns}.unaccent'::regdictionary, coalesce(t,''))) $$`
        : `CREATE OR REPLACE FUNCTION na_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(coalesce(t,'')) $$`,
    )
    const applied = await applyFolder('tenant', t.schema)
    if (capabilities.vector) await q(`ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS embedding vector`).catch(() => {})
    return applied
  })
}

/** Clientes cujo schema deve existir (todos menos os cancelados). */
export async function listTenantsForMigration(): Promise<TenantCtx[]> {
  return withPlatform(async () => {
    const rows = await q<any>(`SELECT id, slug, schema_name, name, status FROM tenants WHERE status <> 'cancelado' ORDER BY created_at`) // contexto mínimo: só para migrar
    return rows.map((r) => ({ kind: 'tenant' as const, id: r.id, slug: r.slug, schema: r.schema_name, name: r.name, status: r.status }))
  })
}

/**
 * Migra a plataforma e todos os clientes. Uma trava consultiva impede dois servidores
 * de migrarem ao mesmo tempo (o segundo espera o primeiro terminar).
 */
export async function migrate(): Promise<{ applied: string[] }> {
  const lockClient = await db().connect()
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('softia:migrate'))`)
    const applied = await migratePlatform()
    for (const t of await listTenantsForMigration()) applied.push(...(await migrateTenant(t)))
    log().info({ capabilities }, 'Banco pronto')
    return { applied }
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('softia:migrate'))`).catch(() => {})
    lockClient.release()
  }
}
