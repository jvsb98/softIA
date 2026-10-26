import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkPasswordPolicy, disableTotp, hashPassword, revokeAllSessions } from '../../auth/service.js'
import { randomToken } from '../../lib/crypto.js'
import { one, q } from '../../lib/db.js'
import { audit } from '../../ops/audit.js'
import { describeHours } from '../../ops/hours.js'
import { allSettings, setSetting } from '../../ops/settings.js'
import { manager } from '../../whatsapp/manager.js'
import { emitStaff } from '../realtime.js'
import { badRequest, notFound } from '../errors.js'
import { clientIp, currentUser, requireRole } from '../app.js'
import { jobStats } from '../../lib/jobs.js'

const uuid = z.string().uuid()
const hoursSchema = z.record(z.string().regex(/^[0-6]$/), z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])))

export async function adminRoutes(app: FastifyInstance) {
  // ============================================================ usuários
  app.get('/api/users', async (req) => {
    currentUser(req)
    return q(
      `SELECT u.id, u.name, u.email, u.role, u.permissions, u.active, u.totp_enabled, u.presence, u.color, u.max_concurrent,
              u.last_login_at, u.last_seen_at, u.created_at, u.locked_until,
              coalesce(array_agg(sm.sector_id) FILTER (WHERE sm.sector_id IS NOT NULL), '{}') AS sector_ids,
              (SELECT count(*) FROM conversations c WHERE c.assignee_id=u.id AND c.status='open') AS open_conversations
         FROM users u LEFT JOIN sector_members sm ON sm.user_id=u.id
        GROUP BY u.id ORDER BY u.active DESC, u.name`,
    )
  })

  const userBody = z.object({
    name: z.string().min(2).max(120),
    email: z.string().email(),
    role: z.enum(['admin', 'supervisor', 'agent']),
    permissions: z.object({ flowsAdvanced: z.boolean(), flowsEdit: z.boolean(), kbEdit: z.boolean(), reports: z.boolean() }).partial().default({}),
    sectorIds: z.array(uuid).default([]),
    maxConcurrent: z.number().int().min(1).max(200).default(25),
    active: z.boolean().default(true),
    color: z.string().max(9).optional(),
  })

  app.post('/api/users', async (req) => {
    const me = requireRole(req, 'admin')
    const body = userBody.extend({ password: z.string().optional() }).parse(req.body)
    const exists = await one(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [body.email])
    if (exists) throw badRequest('Já existe um usuário com este e-mail.')
    const temp = body.password || `Temp-${randomToken(6)}1`
    const policy = await checkPasswordPolicy(temp)
    if (policy) throw badRequest(policy)
    const u = await one<any>(
      `INSERT INTO users(name, email, password_hash, role, permissions, max_concurrent, active, color, must_change_password)
       VALUES ($1,lower($2),$3,$4,$5,$6,$7,coalesce($8,'#99C1E4'), true) RETURNING id`,
      [body.name, body.email, await hashPassword(temp), body.role, JSON.stringify(body.permissions), body.maxConcurrent, body.active, body.color ?? null],
    )
    for (const sid of body.sectorIds) await q(`INSERT INTO sector_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sid, u.id])
    await audit({ userId: me.id, action: 'user.created', entity: 'user', entityId: u.id, data: { email: body.email, role: body.role }, ip: clientIp(req) })
    return { id: u.id, temporaryPassword: body.password ? undefined : temp }
  })

  app.put('/api/users/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const body = userBody.parse(req.body)
    if (id === me.id && (body.role !== 'admin' || !body.active)) throw badRequest('Você não pode remover o seu próprio acesso de administrador.')
    await q(
      `UPDATE users SET name=$2, email=lower($3), role=$4, permissions=$5, max_concurrent=$6, active=$7, color=coalesce($8,color), updated_at=now() WHERE id=$1`,
      [id, body.name, body.email, body.role, JSON.stringify(body.permissions), body.maxConcurrent, body.active, body.color ?? null],
    )
    await q(`DELETE FROM sector_members WHERE user_id=$1`, [id])
    for (const sid of body.sectorIds) await q(`INSERT INTO sector_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sid, id])
    if (!body.active) await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'user.updated', entity: 'user', entityId: id, data: { role: body.role, active: body.active }, ip: clientIp(req) })
    emitStaff('user:changed', { id })
    return { ok: true }
  })

  app.post('/api/users/:id/reset-password', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const temp = `Temp-${randomToken(6)}1`
    await q(`UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL WHERE id=$1`, [id, await hashPassword(temp)])
    await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'user.password_reset', entity: 'user', entityId: id, ip: clientIp(req) })
    return { temporaryPassword: temp }
  })

  app.post('/api/users/:id/reset-2fa', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await disableTotp(id)
    await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'user.2fa_reset', entity: 'user', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/users/:id/unlock', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'user.unlocked', entity: 'user', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ setores
  app.get('/api/sectors', async (req) => {
    currentUser(req)
    const rows = await q(
      `SELECT s.*, coalesce(array_agg(sm.user_id) FILTER (WHERE sm.user_id IS NOT NULL), '{}') AS member_ids,
              (SELECT count(*) FROM conversations c WHERE c.sector_id=s.id AND c.status='queued') AS queued,
              (SELECT count(*) FROM conversations c WHERE c.sector_id=s.id AND c.status='open') AS open
         FROM sectors s LEFT JOIN sector_members sm ON sm.sector_id=s.id
        GROUP BY s.id ORDER BY s.sort, s.name`,
    )
    return rows.map((r: any) => ({ ...r, hours_label: describeHours(r.hours ?? {}) }))
  })

  const sectorBody = z.object({
    name: z.string().min(2).max(60),
    description: z.string().max(240).nullable().optional(),
    color: z.string().max(9).default('#99C1E4'),
    distribution: z.enum(['round_robin', 'least_busy', 'pull']).default('round_robin'),
    hours: hoursSchema.default({}),
    hoursEnabled: z.boolean().default(true),
    timezone: z.string().default('America/Sao_Paulo'),
    offhoursMessage: z.string().max(1000).nullable().optional(),
    active: z.boolean().default(true),
    sort: z.number().int().default(0),
    memberIds: z.array(uuid).default([]),
  })

  const slugify = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')

  app.post('/api/sectors', async (req) => {
    const me = requireRole(req, 'admin', 'supervisor')
    const b = sectorBody.parse(req.body)
    const s = await one<any>(
      `INSERT INTO sectors(name, slug, description, color, distribution, hours, hours_enabled, timezone, offhours_message, active, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [b.name, `${slugify(b.name)}-${randomToken(3).toLowerCase()}`, b.description ?? null, b.color, b.distribution, JSON.stringify(b.hours), b.hoursEnabled, b.timezone, b.offhoursMessage ?? null, b.active, b.sort],
    )
    for (const uid of b.memberIds) await q(`INSERT INTO sector_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [s.id, uid])
    await audit({ userId: me.id, action: 'sector.created', entity: 'sector', entityId: s.id, data: { name: b.name }, ip: clientIp(req) })
    return { id: s.id }
  })

  app.put('/api/sectors/:id', async (req) => {
    const me = requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = sectorBody.parse(req.body)
    await q(
      `UPDATE sectors SET name=$2, description=$3, color=$4, distribution=$5, hours=$6, hours_enabled=$7, timezone=$8, offhours_message=$9, active=$10, sort=$11 WHERE id=$1`,
      [id, b.name, b.description ?? null, b.color, b.distribution, JSON.stringify(b.hours), b.hoursEnabled, b.timezone, b.offhoursMessage ?? null, b.active, b.sort],
    )
    await q(`DELETE FROM sector_members WHERE sector_id=$1`, [id])
    for (const uid of b.memberIds) await q(`INSERT INTO sector_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, uid])
    await audit({ userId: me.id, action: 'sector.updated', entity: 'sector', entityId: id, data: { name: b.name }, ip: clientIp(req) })
    emitStaff('sectors:changed', { id })
    return { ok: true }
  })

  // ============================================================ conexões
  app.get('/api/connections', async (req) => {
    currentUser(req)
    const rows = await q(
      `SELECT c.*, (SELECT count(*) FROM conversations v WHERE v.connection_id=c.id AND v.status<>'closed') AS active_conversations
         FROM connections c ORDER BY c.created_at`,
    )
    return rows.map((r: any) => ({ ...r, qr: manager.get(r.id)?.qr ?? null }))
  })

  const connBody = z.object({
    name: z.string().min(2).max(60),
    color: z.string().max(9).default('#FE5A51'),
    defaultSectorId: uuid.nullable().optional(),
    allowedSectorIds: z.array(uuid).default([]),
    entryFlowId: uuid.nullable().optional(),
    enabled: z.boolean().default(true),
    settings: z.record(z.string(), z.any()).default({}),
  })

  app.post('/api/connections', async (req) => {
    const me = requireRole(req, 'admin')
    const b = connBody.parse(req.body)
    const c = await one<any>(
      `INSERT INTO connections(name, color, default_sector_id, allowed_sector_ids, enabled, settings) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.name, b.color, b.defaultSectorId ?? null, b.allowedSectorIds, b.enabled, JSON.stringify(b.settings)],
    )
    if (b.entryFlowId !== undefined) await q(`UPDATE connections SET entry_flow_id=$2 WHERE id=$1`, [c.id, b.entryFlowId]).catch(() => {})
    await audit({ userId: me.id, action: 'connection.created', entity: 'connection', entityId: c.id, data: { name: b.name }, ip: clientIp(req) })
    return { id: c.id }
  })

  app.put('/api/connections/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = connBody.parse(req.body)
    await q(
      `UPDATE connections SET name=$2, color=$3, default_sector_id=$4, allowed_sector_ids=$5, enabled=$6, settings=$7 WHERE id=$1`,
      [id, b.name, b.color, b.defaultSectorId ?? null, b.allowedSectorIds, b.enabled, JSON.stringify(b.settings)],
    )
    if (b.entryFlowId !== undefined) await q(`UPDATE connections SET entry_flow_id=$2 WHERE id=$1`, [id, b.entryFlowId]).catch(() => {})
    if (!b.enabled) await manager.disconnect(id)
    await audit({ userId: me.id, action: 'connection.updated', entity: 'connection', entityId: id, ip: clientIp(req) })
    emitStaff('connections:changed', { id })
    return { ok: true }
  })

  app.post('/api/connections/:id/connect', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await manager.connect(id)
    await audit({ userId: me.id, action: 'connection.connect', entity: 'connection', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/connections/:id/disconnect', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await manager.disconnect(id)
    await audit({ userId: me.id, action: 'connection.disconnect', entity: 'connection', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/connections/:id/logout', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await manager.logout(id)
    await audit({ userId: me.id, action: 'connection.logout', entity: 'connection', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.delete('/api/connections/:id', async (req) => {
    const me = requireRole(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const active = await one<{ n: number }>(`SELECT count(*) AS n FROM conversations WHERE connection_id=$1`, [id])
    if ((active?.n ?? 0) > 0) throw badRequest('Esta conexão tem conversas registradas. Desative-a em vez de excluir.')
    await manager.logout(id).catch(() => {})
    await manager.remove(id)
    await q(`DELETE FROM connections WHERE id=$1`, [id])
    await audit({ userId: me.id, action: 'connection.deleted', entity: 'connection', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ etiquetas e respostas rápidas
  app.get('/api/tags', async (req) => {
    currentUser(req)
    return q(`SELECT t.*, (SELECT count(*) FROM contact_tags x WHERE x.tag_id=t.id) AS uses FROM tags t ORDER BY name`)
  })
  app.post('/api/tags', async (req) => {
    currentUser(req)
    const b = z.object({ name: z.string().min(1).max(40), color: z.string().max(9).default('#99C1E4') }).parse(req.body)
    return one(`INSERT INTO tags(name, color) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET color=EXCLUDED.color RETURNING *`, [b.name.trim(), b.color])
  })
  app.delete('/api/tags/:id', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM tags WHERE id=$1`, [id])
    return { ok: true }
  })

  app.get('/api/quick-replies', async (req) => {
    const u = currentUser(req)
    return q(
      `SELECT qr.*, s.name AS sector_name FROM quick_replies qr LEFT JOIN sectors s ON s.id=qr.sector_id
        WHERE qr.sector_id IS NULL OR qr.sector_id = ANY($1) OR $2 ORDER BY qr.shortcut`,
      [u.sectorIds, u.role !== 'agent'],
    )
  })
  const qrBody = z.object({
    shortcut: z.string().min(1).max(30).regex(/^[\w-]+$/, 'use letras, números, - ou _'),
    title: z.string().min(1).max(80),
    body: z.string().min(1).max(4000),
    sectorId: uuid.nullable().optional(),
  })
  app.post('/api/quick-replies', async (req) => {
    const u = requireRole(req, 'admin', 'supervisor')
    const b = qrBody.parse(req.body)
    return one(`INSERT INTO quick_replies(shortcut, title, body, sector_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
      b.shortcut,
      b.title,
      b.body,
      b.sectorId ?? null,
      u.id,
    ])
  })
  app.put('/api/quick-replies/:id', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = qrBody.parse(req.body)
    await q(`UPDATE quick_replies SET shortcut=$2, title=$3, body=$4, sector_id=$5 WHERE id=$1`, [id, b.shortcut, b.title, b.body, b.sectorId ?? null])
    return { ok: true }
  })
  app.delete('/api/quick-replies/:id', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await q(`DELETE FROM quick_replies WHERE id=$1`, [id])
    return { ok: true }
  })

  // ============================================================ configurações
  const EDITABLE = ['org', 'security', 'pacing', 'inbox', 'retention', 'compliance', 'ai', 'handoff', 'qualification', 'followups', 'notifications'] as const
  app.get('/api/settings', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    return allSettings()
  })
  app.put('/api/settings/:key', async (req) => {
    const me = requireRole(req, 'admin')
    const { key } = z.object({ key: z.enum(EDITABLE) }).parse(req.params)
    const value = z.record(z.string(), z.any()).parse(req.body)
    await setSetting(key, value, me.id)
    await audit({ userId: me.id, action: 'settings.updated', entity: 'settings', entityId: key, data: { keys: Object.keys(value) }, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ auditoria
  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin')
    const qs = z
      .object({ action: z.string().optional(), before: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(200).default(100) })
      .parse(req.query)
    return q(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
        WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::bigint IS NULL OR a.id < $2)
        ORDER BY a.id DESC LIMIT $3`,
      [qs.action ?? null, qs.before ?? null, qs.limit],
    )
  })

  app.get('/api/system/status', async (req) => {
    requireRole(req, 'admin', 'supervisor')
    const { jobs, failed } = await jobStats()
    const db = await one(`SELECT version() AS version, pg_database_size(current_database()) AS size`)
    const { capabilities } = await import('../../lib/db.js')
    return {
      jobs,
      failed,
      db,
      capabilities,
      connections: manager.list().map((c) => ({ id: c.id, name: c.name, status: c.status, error: c.lastError })),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
      platform: process.platform,
    }
  })

  app.get('/api/users/:id', async (req) => {
    currentUser(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const u = await one(`SELECT id, name, email, role, color, presence FROM users WHERE id=$1`, [id])
    if (!u) throw notFound()
    return u
  })
}
