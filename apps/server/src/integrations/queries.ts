/**
 * Consultas cadastradas a outras bases de dados (somente leitura).
 *
 * A IA e os fluxos nunca escrevem SQL: escolhem uma consulta cadastrada e preenchem
 * os parâmetros. Cada execução roda em transação somente leitura (PostgreSQL/MySQL),
 * com tempo limite, limite de linhas, campos permitidos, máscaras e registro em query_runs.
 */
import mysql from 'mysql2/promise'
import mssql from 'mssql'
import pg from 'pg'
import { decryptSecret } from '../lib/crypto.js'
import { one, q } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { resolveSafeHost } from '../lib/net-guard.js'

export interface ParamSpec {
  name: string
  type: 'text' | 'number' | 'cpf' | 'email' | 'date'
  description?: string
  required?: boolean
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|exec|execute|merge|call|copy|vacuum|lock|attach|replace|rename|comment|pg_sleep|waitfor|xp_\w+|into\s+outfile|load_file|sleep\s*\()\b/i

/** Só permite SELECT/WITH, um único comando, sem comentários. */
export function guardSql(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, '')
  if (!/^(select|with)\b/i.test(s)) return 'A consulta precisa começar com SELECT ou WITH.'
  if (s.includes(';')) return 'Use um único comando (sem ";" no meio).'
  if (/--|\/\*/.test(s)) return 'Remova comentários do SQL.'
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''")
  const m = noStrings.match(FORBIDDEN)
  if (m) return `Comando não permitido na consulta: ${m[0]}`
  return null
}

/** Converte :param em placeholders do driver, ignorando ::cast e textos entre aspas. */
export function compileParams(sql: string, kind: 'postgres' | 'mysql' | 'mssql', values: Record<string, any>) {
  const ordered: any[] = []
  const names: string[] = []
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1)
      const j = end < 0 ? sql.length : end + 1
      out += sql.slice(i, j)
      i = j
      continue
    }
    if (ch === ':' && sql[i + 1] === ':') {
      out += '::'
      i += 2
      continue
    }
    if (ch === ':' && /[a-zA-Z_]/.test(sql[i + 1] ?? '')) {
      const m = sql.slice(i + 1).match(/^[a-zA-Z_][a-zA-Z0-9_]*/)!
      const name = m[0]
      names.push(name)
      ordered.push(values[name] ?? null)
      out += kind === 'postgres' ? `$${ordered.length}` : kind === 'mysql' ? '?' : `@${name}`
      i += 1 + name.length
      continue
    }
    out += ch
    i++
  }
  return { sql: out, values: ordered, names }
}

export function normalizeParam(spec: ParamSpec, v: any): any {
  if (v === undefined || v === null || v === '') return null
  switch (spec.type) {
    case 'number':
      return Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'))
    case 'cpf':
      return String(v).replace(/\D/g, '')
    case 'email':
      return String(v).trim().toLowerCase()
    default:
      return String(v).trim()
  }
}

export function maskValue(kind: string, v: any): any {
  if (v === null || v === undefined) return v
  const s = String(v)
  switch (kind) {
    case 'cpf': {
      const d = s.replace(/\D/g, '')
      return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '***'
    }
    case 'email': {
      const [u, dom] = s.split('@')
      return dom ? `${u!.slice(0, 1)}***@${dom}` : '***'
    }
    case 'phone': {
      const d = s.replace(/\D/g, '')
      return d.length > 4 ? `(**) *****-${d.slice(-4)}` : '***'
    }
    case 'partial':
      return s.length > 3 ? `${s.slice(0, 3)}***` : '***'
    default:
      return v
  }
}

export function shapeRows(rows: any[], query: { output_fields: string[]; masks: Record<string, string>; max_rows: number }) {
  return rows.slice(0, query.max_rows).map((r) => {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(r)) {
      if (query.output_fields?.length && !query.output_fields.includes(k)) continue
      const m = query.masks?.[k]
      if (m === 'hide') continue
      out[k] = m ? maskValue(m, v) : v instanceof Date ? v.toISOString() : v
    }
    return out
  })
}

async function runOn(db: any, sql: string, values: Record<string, any>, timeoutMs: number, maxRows: number): Promise<any[]> {
  const password = decryptSecret(db.password_enc)
  // SaaS: o banco externo não pode ser um endereço interno do servidor (nem o nosso próprio Postgres)
  const ip = await resolveSafeHost(db.host)
  const ssl = db.ssl === 'false' ? false : db.ssl === 'true' ? { rejectUnauthorized: true, servername: db.host } : { rejectUnauthorized: false, servername: db.host }
  if (db.kind === 'postgres') {
    const c = new pg.Client({ host: ip, port: db.port, database: db.database, user: db.username, password, ssl, connectionTimeoutMillis: 8000, application_name: 'softia-consulta' })
    await c.connect()
    try {
      await c.query('BEGIN READ ONLY')
      await c.query(`SET LOCAL statement_timeout = ${Math.max(500, Math.min(60000, timeoutMs))}`)
      const compiled = compileParams(sql, 'postgres', values)
      const r = await c.query(`SELECT * FROM (${compiled.sql}) AS consulta LIMIT ${maxRows + 1}`, compiled.values)
      await c.query('ROLLBACK')
      return r.rows
    } finally {
      await c.end().catch(() => {})
    }
  }
  if (db.kind === 'mysql') {
    const c = await mysql.createConnection({ host: ip, port: db.port, database: db.database, user: db.username, password, ssl: ssl || undefined, connectTimeout: 8000 })
    try {
      await c.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(500, Math.min(60000, timeoutMs))}`)
      await c.query('START TRANSACTION READ ONLY')
      const compiled = compileParams(sql, 'mysql', values)
      const [rows] = await c.query({ sql: `SELECT * FROM (${compiled.sql}) AS consulta LIMIT ${maxRows + 1}`, values: compiled.values, timeout: timeoutMs })
      await c.query('ROLLBACK')
      return rows as any[]
    } finally {
      await c.end().catch(() => {})
    }
  }
  // SQL Server: o usuário deve ter apenas permissão de leitura (db_datareader)
  const pool = await new mssql.ConnectionPool({
    server: ip,
    port: db.port,
    database: db.database,
    user: db.username,
    password,
    options: { encrypt: db.ssl !== 'false', trustServerCertificate: db.ssl === 'no-verify', serverName: db.host },
    requestTimeout: timeoutMs,
    connectionTimeout: 8000,
  }).connect()
  try {
    const compiled = compileParams(sql, 'mssql', values)
    const req = pool.request()
    compiled.names.forEach((n, i) => req.input(n, compiled.values[i]))
    const r = await req.query(`SELECT TOP (${maxRows + 1}) * FROM (${compiled.sql}) AS consulta`)
    return r.recordset
  } finally {
    await pool.close().catch(() => {})
  }
}

export interface ExecCtx {
  conversationId?: string | null
  actor: 'ai' | 'flow' | 'agent' | 'test'
  userId?: string | null
}

/** Executa uma consulta cadastrada com todas as proteções e registra a execução. */
export async function executeSavedQuery(queryId: string, rawParams: Record<string, any>, ctx: ExecCtx): Promise<{ rows: any[]; error?: string; truncated?: boolean }> {
  const qry = await one<any>(`SELECT q.*, row_to_json(d) AS db FROM saved_queries q JOIN external_databases d ON d.id=q.database_id WHERE q.id=$1`, [queryId])
  if (!qry || !qry.enabled || !qry.db?.enabled) return { rows: [], error: 'Consulta indisponível' }
  const guard = guardSql(qry.sql)
  if (guard) return { rows: [], error: guard }

  const specs: ParamSpec[] = qry.params ?? []
  const values: Record<string, any> = {}
  for (const s of specs) {
    values[s.name] = normalizeParam(s, rawParams?.[s.name])
    if (s.required && values[s.name] === null) return { rows: [], error: `Parâmetro obrigatório ausente: ${s.name}` }
  }

  // Verificação de identidade: só roda se a conversa verificou o titular, e com os MESMOS dados verificados
  if (qry.requires_verification && ctx.actor !== 'test') {
    const conv = ctx.conversationId ? await one<any>(`SELECT context FROM conversations WHERE id=$1`, [ctx.conversationId]) : null
    const ident = conv?.context?.identity
    if (!ident?.verified || Date.now() - new Date(ident.at).getTime() > 24 * 3600_000) {
      return { rows: [], error: 'verificacao_necessaria: confirme a identidade do contato antes (ferramenta verificar_identidade)' }
    }
    for (const [k, v] of Object.entries(ident.params ?? {})) {
      if (k in values && values[k] !== null && String(values[k]) !== String(v)) {
        return { rows: [], error: 'Os dados informados não correspondem à identidade verificada nesta conversa.' }
      }
      if (k in values && values[k] === null) values[k] = v
    }
  }

  const masked: Record<string, any> = {}
  for (const s of specs) masked[s.name] = s.type === 'cpf' ? maskValue('cpf', values[s.name]) : s.type === 'email' ? maskValue('email', values[s.name]) : values[s.name]

  const t0 = Date.now()
  try {
    const rows = await runOn(qry.db, qry.sql.trim().replace(/;\s*$/, ''), values, qry.timeout_ms, qry.max_rows)
    const shaped = shapeRows(rows, qry)
    await q(`INSERT INTO query_runs(query_id, conversation_id, actor, user_id, params_masked, rows, ms, ok) VALUES ($1,$2,$3,$4,$5,$6,$7,true)`, [
      qry.id,
      ctx.conversationId ?? null,
      ctx.actor,
      ctx.userId ?? null,
      JSON.stringify(masked),
      shaped.length,
      Date.now() - t0,
    ])
    return { rows: shaped, truncated: rows.length > qry.max_rows }
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 300)
    log().warn({ query: qry.name, err: msg }, 'Falha na consulta externa')
    await q(`INSERT INTO query_runs(query_id, conversation_id, actor, user_id, params_masked, ms, ok, error) VALUES ($1,$2,$3,$4,$5,$6,false,$7)`, [
      qry.id,
      ctx.conversationId ?? null,
      ctx.actor,
      ctx.userId ?? null,
      JSON.stringify(masked),
      Date.now() - t0,
      msg,
    ])
    return { rows: [], error: 'A consulta falhou. Tente mais tarde.' }
  }
}

/** Testa a conexão com uma base externa. */
export async function testDatabase(db: any): Promise<{ ok: boolean; message: string; ms: number }> {
  const t0 = Date.now()
  try {
    const sql = db.kind === 'mssql' ? 'SELECT 1 AS ok' : 'SELECT 1 AS ok'
    await runOn(db, sql, {}, 5000, 1)
    return { ok: true, message: 'Conexão bem-sucedida', ms: Date.now() - t0 }
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err).slice(0, 300), ms: Date.now() - t0 }
  }
}

/** Verifica a identidade do contato com a consulta marcada como "de verificação". */
export async function verifyIdentity(conversationId: string, params: Record<string, any>) {
  const vq = await one<any>(`SELECT id, params FROM saved_queries WHERE is_verification AND enabled LIMIT 1`)
  if (!vq) return { verificado: false, erro: 'Nenhuma consulta de verificação configurada' }
  const r = await executeSavedQuery(vq.id, params, { conversationId, actor: 'ai' })
  const ok = !r.error && r.rows.length > 0
  if (ok) {
    const norm: Record<string, any> = {}
    for (const s of vq.params as ParamSpec[]) norm[s.name] = normalizeParam(s, params[s.name])
    await q(`UPDATE conversations SET context = jsonb_set(context, '{identity}', $2::jsonb) WHERE id=$1`, [
      conversationId,
      JSON.stringify({ verified: true, at: new Date().toISOString(), params: norm }),
    ])
  } else {
    const attempts = await one<any>(`SELECT coalesce((context->'identity'->>'failures')::int,0)+1 AS n FROM conversations WHERE id=$1`, [conversationId])
    await q(`UPDATE conversations SET context = jsonb_set(context, '{identity}', $2::jsonb) WHERE id=$1`, [
      conversationId,
      JSON.stringify({ verified: false, failures: attempts?.n ?? 1, at: new Date().toISOString() }),
    ])
    if ((attempts?.n ?? 1) >= 3) return { verificado: false, bloqueado: true, instrucao: 'Muitas tentativas. Transfira para o Suporte.' }
  }
  return { verificado: ok, instrucao: ok ? 'Identidade confirmada. Você pode usar as consultas que exigem verificação.' : 'Os dados não conferem. Peça para o contato revisar (CPF e e-mail cadastrados).' }
}
