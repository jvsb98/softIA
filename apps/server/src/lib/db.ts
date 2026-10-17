import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { DatabaseConfig } from './config.js'
import { log } from './logger.js'

const { Pool, types } = pg

// BIGINT (count, sum) como número; NUMERIC como número; datas como string ISO.
types.setTypeParser(20, (v) => Number(v))
types.setTypeParser(1700, (v) => Number(v))

export type Db = pg.Pool
export type Tx = pg.PoolClient
export type Queryable = pg.Pool | pg.PoolClient

let pool: pg.Pool | null = null

export const capabilities = { vector: false, unaccent: false, trgm: false }

export function createPool(cfg: DatabaseConfig): pg.Pool {
  pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.poolMax,
    ssl: cfg.ssl === false ? false : { rejectUnauthorized: cfg.ssl === true, ca: cfg.sslCa },
    application_name: 'nimber-atende',
    options: cfg.schema && cfg.schema !== 'public' ? `-c search_path=${cfg.schema},public` : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
  pool.on('error', (err) => log().error({ err: { message: err.message, code: (err as any).code } }, 'Erro inesperado no pool do PostgreSQL'))
  return pool
}

export function db(): pg.Pool {
  if (!pool) throw new Error('Banco não inicializado')
  return pool
}

export async function q<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T[]> {
  const r = await client.query<T>(sql, params as any[])
  return r.rows
}

export async function one<T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T | null> {
  const r = await client.query<T>(sql, params as any[])
  return r.rows[0] ?? null
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect()
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

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dev: src/lib → ../../migrations · build: dist/lib → ../migrations
  for (const p of [join(here, '..', '..', 'migrations'), join(here, '..', 'migrations')]) {
    if (existsSync(p)) return p
  }
  throw new Error('Pasta de migrações não encontrada')
}

async function tryExtension(name: string): Promise<boolean> {
  try {
    await db().query(`CREATE EXTENSION IF NOT EXISTS ${name}`)
    return true
  } catch {
    const r = await one<{ ok: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS ok`, [name])
    return !!r?.ok
  }
}

/**
 * Executa as migrações pendentes em ordem (cada arquivo numa transação) e detecta
 * extensões opcionais. pgvector, unaccent e pg_trgm são opcionais: o sistema
 * funciona sem elas (com busca textual simples).
 */
export async function migrate(): Promise<{ applied: string[] }> {
  const l = log()
  await db().query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`)

  capabilities.unaccent = await tryExtension('unaccent')
  capabilities.trgm = await tryExtension('pg_trgm')
  capabilities.vector = await tryExtension('vector')
  await tryExtension('pgcrypto')

  // Função de normalização usada na busca textual (com ou sem unaccent).
  await db().query(
    capabilities.unaccent
      ? `CREATE OR REPLACE FUNCTION na_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t,''))) $$`
      : `CREATE OR REPLACE FUNCTION na_norm(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT lower(coalesce(t,'')) $$`,
  )

  const done = new Set((await q<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name))
  const dir = migrationsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    const sql = readFileSync(join(dir, f), 'utf8')
    await tx(async (c) => {
      await c.query(sql)
      await c.query(`INSERT INTO schema_migrations(name) VALUES ($1)`, [f])
    })
    applied.push(f)
    l.info({ migration: f }, 'Migração aplicada')
  }

  if (capabilities.vector) {
    await db().query(`ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS embedding vector`).catch(() => {})
  }
  l.info({ capabilities }, 'Banco pronto')
  return { applied }
}
