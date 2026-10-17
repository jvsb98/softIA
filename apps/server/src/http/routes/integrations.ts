import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { encryptSecret, randomToken } from '../../lib/crypto.js'
import { one, q } from '../../lib/db.js'
import { enqueue } from '../../lib/jobs.js'
import { audit } from '../../ops/audit.js'
import { executeSavedQuery, guardSql, testDatabase } from '../../integrations/queries.js'
import { WEBHOOK_EVENTS } from '../../integrations/webhooks.js'
import { badRequest, notFound } from '../errors.js'
import { clientIp, currentUser, requireRole } from '../app.js'

const uuid = z.string().uuid()

export async function integrationRoutes(app: FastifyInstance) {
  // ============================================================ bases externas
  app.get('/api/integrations/databases', async (req) => {
    requireRole(req, 'admin')
    const rows = await q<any>(`SELECT id, name, kind, host, port, database, username, ssl, enabled, created_at, password_enc IS NOT NULL AS has_password FROM external_databases ORDER BY name`)
    return rows
  })

  const dbBody = z.object({
    name: z.string().min(2).max(60),
    kind: z.enum(['postgres', 'mysql', 'mssql']),
    host: z.string().min(1).max(200),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(120),
    username: z.string().min(1).max(120),
    password: z.string().max(300).optional(),
    ssl: z.enum(['false', 'true', 'no-verify']).default('false'),
    enabled: z.boolean().default(true),
  })

  app.post('/api/integrations/databases', async (req) => {
    const me = requireRole(req, 'admin')
    const b = dbBody.parse(req.body)
    const r = await one<any>(
      `INSERT INTO external_databases(name, kind, host, port, database, username, password_enc, ssl, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.name, b.kind, b.host, b.port, b.database, b.username, b.password ? encryptSecret(b.password) : null, b.ssl, b.enabled],
    )
    await audit({ userId: me.id, action: 'integration.db_created', entity: 'external_database', entityId: r.id, data: { name: b.name, kind: b.kind, host: b.host }, ip: clientIp(req) })
    return r
  })

  app.put('/api/integrations/databases/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = dbBody.parse(req.body)
    await q(
      `UPDATE external_databases SET name=$2, kind=$3, host=$4, port=$5, database=$6, username=$7, ssl=$8, enabled=$9,
              password_enc = CASE WHEN $10::text IS NULL THEN password_enc ELSE $10 END WHERE id=$1`,
      [id, b.name, b.kind, b.host, b.port, b.database, b.username, b.ssl, b.enabled, b.password ? encryptSecret(b.password) : null],
    )
    await audit({ userId: me.id, action: 'integration.db_updated', entity: 'external_database', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.delete('/api/integrations/databases/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM external_databases WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'integration.db_deleted', entity: 'external_database', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/integrations/databases/:id/test', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const db = await one<any>(`SELECT * FROM external_databases WHERE id=$1`, [id])
    if (!db) throw notFound()
    return testDatabase(db)
  })

  // ============================================================ consultas cadastradas
  app.get('/api/integrations/queries', async (req) => {
    currentUser(req)
    const rows = await q<any>(
      `SELECT q.*, d.name AS database_name, d.kind AS database_kind,
              (SELECT count(*) FROM query_runs r WHERE r.query_id=q.id AND r.created_at > now() - interval '7 days') AS runs_7d
         FROM saved_queries q JOIN external_databases d ON d.id=q.database_id ORDER BY q.label`,
    )
    const u = currentUser(req)
    return u.role === 'admin' ? rows : rows.map((r) => ({ id: r.id, name: r.name, label: r.label, description: r.description, params: r.params, enabled: r.enabled }))
  })

  const queryBody = z.object({
    databaseId: uuid,
    name: z.string().min(2).max(50).regex(/^[a-z][a-z0-9_]*$/, 'use letras minúsculas, números e _'),
    label: z.string().min(2).max(80),
    description: z.string().min(10).max(600),
    sql: z.string().min(10).max(8000),
    params: z.array(z.object({ name: z.string().regex(/^[a-z_][a-z0-9_]*$/i), type: z.enum(['text', 'number', 'cpf', 'email', 'date']), description: z.string().max(200).optional(), required: z.boolean().default(true) })).max(10).default([]),
    outputFields: z.array(z.string().max(80)).max(40).default([]),
    masks: z.record(z.string(), z.enum(['cpf', 'email', 'phone', 'partial', 'hide'])).default({}),
    maxRows: z.number().int().min(1).max(200).default(20),
    timeoutMs: z.number().int().min(500).max(60000).default(5000),
    requiresVerification: z.boolean().default(false),
    isVerification: z.boolean().default(false),
    aiEnabled: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })

  const checkQuery = (b: z.infer<typeof queryBody>) => {
    const g = guardSql(b.sql)
    if (g) throw badRequest(g)
    const used = [...b.sql.replace(/'(?:[^']|'')*'/g, '').matchAll(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]!)
    const declared = new Set(b.params.map((p) => p.name))
    const missing = [...new Set(used)].filter((u) => !declared.has(u))
    if (missing.length) throw badRequest(`Declare os parâmetros usados no SQL: ${missing.join(', ')}`)
  }

  app.post('/api/integrations/queries', async (req) => {
    const me = requireRole(req, 'admin')
    const b = queryBody.parse(req.body)
    checkQuery(b)
    if (b.isVerification) await q(`UPDATE saved_queries SET is_verification=false`)
    const r = await one<any>(
      `INSERT INTO saved_queries(database_id, name, label, description, sql, params, output_fields, masks, max_rows, timeout_ms, requires_verification, is_verification, ai_enabled, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [b.databaseId, b.name, b.label, b.description, b.sql, JSON.stringify(b.params), b.outputFields, JSON.stringify(b.masks), b.maxRows, b.timeoutMs, b.requiresVerification, b.isVerification, b.aiEnabled, b.enabled, me.id],
    )
    await audit({ userId: me.id, action: 'query.created', entity: 'saved_query', entityId: r.id, data: { name: b.name }, ip: clientIp(req) })
    return r
  })

  app.put('/api/integrations/queries/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = queryBody.parse(req.body)
    checkQuery(b)
    if (b.isVerification) await q(`UPDATE saved_queries SET is_verification=false WHERE id<>$1`, [id])
    await q(
      `UPDATE saved_queries SET database_id=$2, name=$3, label=$4, description=$5, sql=$6, params=$7, output_fields=$8, masks=$9, max_rows=$10, timeout_ms=$11,
              requires_verification=$12, is_verification=$13, ai_enabled=$14, enabled=$15, updated_at=now() WHERE id=$1`,
      [id, b.databaseId, b.name, b.label, b.description, b.sql, JSON.stringify(b.params), b.outputFields, JSON.stringify(b.masks), b.maxRows, b.timeoutMs, b.requiresVerification, b.isVerification, b.aiEnabled, b.enabled],
    )
    await audit({ userId: me.id, action: 'query.updated', entity: 'saved_query', entityId: id, data: { name: b.name }, ip: clientIp(req) })
    return { ok: true }
  })

  app.delete('/api/integrations/queries/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM saved_queries WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'query.deleted', entity: 'saved_query', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/integrations/queries/:id/test', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { params } = z.object({ params: z.record(z.string(), z.any()).default({}) }).parse(req.body ?? {})
    const t0 = Date.now()
    const r = await executeSavedQuery(id, params, { actor: 'test', userId: me.id })
    await audit({ userId: me.id, action: 'query.tested', entity: 'saved_query', entityId: id, ip: clientIp(req) })
    return { ...r, ms: Date.now() - t0 }
  })

  app.get('/api/integrations/query-runs', async (req) => {
    requireRole(req, 'admin')
    return q(
      `SELECT r.*, q.label AS query_label, u.name AS user_name FROM query_runs r LEFT JOIN saved_queries q ON q.id=r.query_id LEFT JOIN users u ON u.id=r.user_id
        ORDER BY r.id DESC LIMIT 100`,
    )
  })

  // ============================================================ webhooks
  app.get('/api/integrations/webhooks', async (req) => {
    requireRole(req, 'admin')
    const hooks = await q<any>(
      `SELECT w.*, (SELECT count(*) FROM webhook_deliveries d WHERE d.webhook_id=w.id AND d.status='failed' AND d.created_at > now() - interval '7 days') AS failed_7d,
              (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.webhook_id=w.id) AS last_delivered_at
         FROM webhooks w ORDER BY created_at`,
    )
    return { hooks, events: WEBHOOK_EVENTS }
  })

  const hookBody = z.object({ name: z.string().min(2).max(60), url: z.string().url(), events: z.array(z.string()).min(1), enabled: z.boolean().default(true) })
  app.post('/api/integrations/webhooks', async (req) => {
    const me = requireRole(req, 'admin')
    const b = hookBody.parse(req.body)
    const secret = randomToken(24)
    const r = await one<any>(`INSERT INTO webhooks(name, url, secret, events, enabled) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [b.name, b.url, secret, b.events, b.enabled])
    await audit({ userId: me.id, action: 'integration.webhook_created', entity: 'webhook', entityId: r.id, data: { url: b.url }, ip: clientIp(req) })
    return { id: r.id, secret }
  })
  app.put('/api/integrations/webhooks/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = hookBody.parse(req.body)
    await q(`UPDATE webhooks SET name=$2, url=$3, events=$4, enabled=$5 WHERE id=$1`, [id, b.name, b.url, b.events, b.enabled])
    await audit({ userId: me.id, action: 'integration.webhook_updated', entity: 'webhook', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })
  app.delete('/api/integrations/webhooks/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM webhooks WHERE id=$1`, [id])
    return { ok: true }
  })
  app.post('/api/integrations/webhooks/:id/test', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const h = await one<any>(`SELECT id FROM webhooks WHERE id=$1`, [id])
    if (!h) throw notFound()
    const d = await one<any>(`INSERT INTO webhook_deliveries(webhook_id, event, payload) VALUES ($1,'test',$2) RETURNING id`, [
      id,
      JSON.stringify({ event: 'test', sentAt: new Date().toISOString(), data: { message: 'Teste de webhook do Nimber Atende' } }),
    ])
    await enqueue('webhook.deliver', { deliveryId: d.id }, { maxAttempts: 1 })
    return { ok: true, deliveryId: d.id }
  })
  app.get('/api/integrations/webhooks/:id/deliveries', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    return q(`SELECT id, event, status, attempts, response_code, error, created_at, delivered_at FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT 50`, [id])
  })
  app.post('/api/integrations/webhooks/:id/rotate-secret', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const secret = randomToken(24)
    await q(`UPDATE webhooks SET secret=$2 WHERE id=$1`, [id, secret])
    return { secret }
  })

  // ============================================================ feriados
  app.get('/api/holidays', async (req) => {
    currentUser(req)
    return q(`SELECT id, to_char(day,'YYYY-MM-DD') AS day, name FROM holidays WHERE day >= current_date - 30 ORDER BY day`)
  })
  app.post('/api/holidays', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const b = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(2).max(80) }).parse(req.body)
    return one(`INSERT INTO holidays(day, name) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [b.day, b.name])
  })
  app.delete('/api/holidays/:id', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM holidays WHERE id=$1`, [id])
    return { ok: true }
  })

}
