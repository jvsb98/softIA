import type { FastifyInstance } from 'fastify'
import QRCode from 'qrcode'
import { z } from 'zod'
import {
  beginTotpSetup,
  checkPasswordPolicy,
  confirmTotpSetup,
  createSession,
  disableTotp,
  effectivePermissions,
  hashPassword,
  login,
  promoteSession,
  revokeAllSessions,
  revokeSession,
  verifySecondFactor,
} from '../../auth/service.js'
import bcrypt from 'bcryptjs'
import { sha256 } from '../../lib/crypto.js'
import { one, q, tx } from '../../lib/db.js'
import { audit } from '../../ops/audit.js'
import { getSetting } from '../../ops/settings.js'
import { badRequest, conflict, unauthorized } from '../errors.js'
import { clearSessionCookie, clientIp, currentUser, setSessionCookie } from '../app.js'

export async function authRoutes(app: FastifyInstance, secureCookies: boolean) {
  // ------------------------------------------------------------ primeira instalação
  app.get('/api/setup/status', async () => {
    const r = await one<{ n: number }>(`SELECT count(*) AS n FROM users`)
    const conns = await one<{ n: number }>(`SELECT count(*) AS n FROM connections`)
    return { needsSetup: (r?.n ?? 0) === 0, hasConnections: (conns?.n ?? 0) > 0 }
  })

  app.post('/api/setup/admin', async (req, reply) => {
    const body = z
      .object({ name: z.string().min(2).max(120), email: z.string().email(), password: z.string().min(1), orgName: z.string().max(80).optional() })
      .parse(req.body)
    const policy = await checkPasswordPolicy(body.password)
    if (policy) throw badRequest(policy)
    const hash = await hashPassword(body.password)
    // Trava: duas requisições simultâneas não podem criar dois administradores iniciais
    const user = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(7300001)`)
      const n = (await c.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n
      if (n > 0) throw conflict('O sistema já foi configurado.')
      return (
        await c.query(`INSERT INTO users(name, email, password_hash, role, color) VALUES ($1,$2,$3,'admin','#FE5A51') RETURNING id`, [
          body.name,
          body.email.toLowerCase(),
          hash,
        ])
      ).rows[0]
    })
    if (body.orgName) await q(`UPDATE settings SET value = jsonb_set(value,'{name}',to_jsonb($1::text)) WHERE key='org'`, [body.orgName])
    // Admin entra no setor SDR por padrão (pode mudar depois)
    await q(`INSERT INTO sector_members(sector_id, user_id) SELECT id, $1 FROM sectors WHERE active ON CONFLICT DO NOTHING`, [user.id])
    await audit({ userId: user.id, action: 'setup.admin_created', entity: 'user', entityId: user.id, ip: clientIp(req) })
    const token = await createSession(user.id, false, clientIp(req), req.headers['user-agent'])
    setSessionCookie(reply, token, secureCookies)
    return { ok: true }
  })

  // ------------------------------------------------------------ login
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body)
    const r = await login(body.email, body.password, clientIp(req), req.headers['user-agent'])
    if (!r.ok) {
      await audit({ action: 'auth.login_failed', data: { email: body.email.toLowerCase() }, ip: clientIp(req) })
      return reply.status(r.status).send({ error: r.error })
    }
    setSessionCookie(reply, r.token, secureCookies)
    const s = await one<any>(`SELECT user_id FROM user_sessions WHERE id = $1`, [sha256(r.token)])
    await audit({ userId: s?.user_id, action: 'auth.login', ip: clientIp(req) })
    return { mfaRequired: r.mfaRequired, mfaSetupRequired: r.mfaSetupRequired }
  })

  app.post('/api/auth/2fa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(20) }).parse(req.body)
    const s = req.session
    if (!s || !s.mfaPending) throw unauthorized('Faça login novamente.')
    const ok = await verifySecondFactor(s.user.id, code)
    if (!ok) {
      await audit({ userId: s.user.id, action: 'auth.2fa_failed', ip: clientIp(req) })
      throw badRequest('Código inválido ou expirado.')
    }
    await promoteSession(s.sessionId)
    await audit({ userId: s.user.id, action: 'auth.2fa_ok', ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) await revokeSession(req.session.sessionId)
    clearSessionCookie(reply)
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const u = currentUser(req)
    const sec = await getSetting('security', { require2faAdmins: true, require2faAll: false })
    const mustHave2fa = sec.require2faAll || (sec.require2faAdmins && u.role === 'admin')
    const org = await getSetting('org', { name: 'Nimber' })
    return {
      user: { ...u, permissions: effectivePermissions(u.role, u.permissions) },
      mfaSetupRequired: mustHave2fa && !u.totp_enabled,
      org,
    }
  })

  // ------------------------------------------------------------ 2FA (configuração)
  app.post('/api/auth/2fa/setup', async (req) => {
    const u = currentUser(req)
    if (u.totp_enabled) throw conflict('A verificação em duas etapas já está ativa.')
    const { secret, otpauth } = await beginTotpSetup(u.id, u.email)
    const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240, color: { dark: '#071832', light: '#ffffff' } })
    return { secret, otpauth, qr }
  })

  app.post('/api/auth/2fa/confirm', async (req) => {
    const u = currentUser(req)
    const { code } = z.object({ code: z.string().min(6).max(8) }).parse(req.body)
    const codes = await confirmTotpSetup(u.id, code)
    if (!codes) throw badRequest('Código inválido. Confira se o horário do celular está correto e tente de novo.')
    await audit({ userId: u.id, action: 'auth.2fa_enabled', ip: clientIp(req) })
    return { recoveryCodes: codes }
  })

  app.post('/api/auth/2fa/disable', async (req) => {
    const u = currentUser(req)
    const { password } = z.object({ password: z.string().min(1) }).parse(req.body)
    const row = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [u.id])
    if (!row || !(await bcrypt.compare(password, row.password_hash))) throw badRequest('Senha incorreta.')
    const sec = await getSetting('security', { require2faAdmins: true, require2faAll: false })
    if (sec.require2faAll || (sec.require2faAdmins && u.role === 'admin'))
      throw badRequest('A política de segurança exige verificação em duas etapas para o seu perfil.')
    await disableTotp(u.id)
    await audit({ userId: u.id, action: 'auth.2fa_disabled', ip: clientIp(req) })
    return { ok: true }
  })

  // ------------------------------------------------------------ perfil
  app.post('/api/auth/password', async (req) => {
    const u = currentUser(req)
    const body = z.object({ current: z.string().min(1), next: z.string().min(1) }).parse(req.body)
    const row = await one<any>(`SELECT password_hash FROM users WHERE id=$1`, [u.id])
    if (!row || !(await bcrypt.compare(body.current, row.password_hash))) throw badRequest('Senha atual incorreta.')
    const policy = await checkPasswordPolicy(body.next)
    if (policy) throw badRequest(policy)
    await q(`UPDATE users SET password_hash=$2, must_change_password=false, updated_at=now() WHERE id=$1`, [u.id, await hashPassword(body.next)])
    await revokeAllSessions(u.id, req.session!.sessionId)
    await audit({ userId: u.id, action: 'auth.password_changed', ip: clientIp(req) })
    return { ok: true }
  })

  app.patch('/api/auth/profile', async (req) => {
    const u = currentUser(req)
    const body = z
      .object({ name: z.string().min(2).max(120).optional(), signature: z.string().max(80).nullable().optional(), color: z.string().max(9).optional() })
      .parse(req.body)
    await q(
      `UPDATE users SET name=coalesce($2,name), signature=CASE WHEN $3::boolean THEN $4 ELSE signature END, color=coalesce($5,color), updated_at=now() WHERE id=$1`,
      [u.id, body.name ?? null, body.signature !== undefined, body.signature ?? null, body.color ?? null],
    )
    return { ok: true }
  })

  app.get('/api/auth/sessions', async (req) => {
    const u = currentUser(req)
    const rows = await q(
      `SELECT id, ip, user_agent, created_at, last_seen_at, expires_at, id = $2 AS current
         FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
      [u.id, req.session!.sessionId],
    )
    return rows.map((r: any) => ({ ...r, id: r.id.slice(0, 12) }))
  })

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const u = currentUser(req)
    await revokeAllSessions(u.id, req.session!.sessionId)
    return { ok: true }
  })
}
