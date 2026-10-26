import bcrypt from 'bcryptjs'
import { decryptSecret, encryptSecret, randomToken, sha256 } from '../lib/crypto.js'
import { one, q } from '../lib/db.js'
import { getSetting } from '../ops/settings.js'
import { tenantOrNull } from '../lib/tenant.js'
import { generateSecret, otpauthUrl, verifyTotp } from './totp.js'

export type Role = 'admin' | 'supervisor' | 'agent'

export interface Permissions {
  /** nós avançados do construtor (código, HTTP livre, webhooks) */
  flowsAdvanced?: boolean
  /** editar fluxos (nós simples) */
  flowsEdit?: boolean
  /** editar base de conhecimento */
  kbEdit?: boolean
  /** ver relatórios */
  reports?: boolean
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: Role
  permissions: Permissions
  totp_enabled: boolean
  must_change_password: boolean
  color: string
  presence: string
  signature: string | null
  sectorIds: string[]
}

let dummyHash: string | undefined

export const LOCK_THRESHOLD = 5
export const LOCK_MINUTES = 15

/**
 * Permissões efetivas. SaaS: nós avançados (código, HTTP livre) ficam só com a equipe do fornecedor,
 * numa sessão de "entrar como cliente" (platformSession), nunca com os usuários do cliente.
 */
export function effectivePermissions(role: Role, p: Permissions, platformSession = false): Required<Permissions> {
  if (role === 'admin') return { flowsAdvanced: platformSession, flowsEdit: true, kbEdit: true, reports: true }
  if (role === 'supervisor') return { flowsAdvanced: platformSession, flowsEdit: p.flowsEdit ?? true, kbEdit: p.kbEdit ?? true, reports: p.reports ?? true }
  return { flowsAdvanced: platformSession, flowsEdit: !!p.flowsEdit, kbEdit: !!p.kbEdit, reports: !!p.reports }
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12)
}

export async function checkPasswordPolicy(pw: string): Promise<string | null> {
  const sec = await getSetting('security', { passwordMinLength: 10 })
  if (pw.length < sec.passwordMinLength) return `A senha precisa ter pelo menos ${sec.passwordMinLength} caracteres.`
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'A senha precisa ter letras e números.'
  return null
}

export async function loadSessionUser(userId: string): Promise<SessionUser | null> {
  const u = await one<any>(
    `SELECT u.id, u.name, u.email, u.role, u.permissions, u.totp_enabled, u.must_change_password, u.color, u.presence, u.signature,
            coalesce(array_agg(sm.sector_id) FILTER (WHERE sm.sector_id IS NOT NULL), '{}') AS sector_ids
       FROM users u LEFT JOIN sector_members sm ON sm.user_id = u.id
      WHERE u.id = $1 AND u.active
      GROUP BY u.id`,
    [userId],
  )
  if (!u) return null
  return { ...u, sectorIds: u.sector_ids }
}

// ---------------------------------------------------------------- sessões

export async function createSession(userId: string, mfaPending: boolean, ip?: string, ua?: string) {
  const token = randomToken(32)
  const sec = await getSetting('security', { sessionHours: 12 })
  const hours = mfaPending ? 0.25 : sec.sessionHours
  await q(
    `INSERT INTO user_sessions(id, user_id, mfa_pending, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval)`,
    [sha256(token), userId, mfaPending, ip ?? null, (ua ?? '').slice(0, 300), String(hours)],
  )
  return token
}

export interface ResolvedSession {
  sessionId: string
  user: SessionUser
  mfaPending: boolean
  /** sessão aberta pela equipe do fornecedor ("entrar como cliente") */
  impersonation: { by: string; byName: string | null; reason: string | null; expiresAt: string } | null
}

const touchCache = new Map<string, number>()

export async function resolveSession(token: string | undefined): Promise<ResolvedSession | null> {
  if (!token) return null
  const id = sha256(token)
  const s = await one<any>(
    `SELECT id, user_id, mfa_pending, expires_at, impersonated_by, impersonated_by_name, impersonation_reason
       FROM user_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at > now()
        -- acesso do fornecedor: cai na hora se a pessoa da equipe for desativada
        AND (impersonated_by IS NULL OR EXISTS (SELECT 1 FROM plataforma.users pu WHERE pu.id = user_sessions.impersonated_by AND pu.active))`,
    [id],
  )
  if (!s) return null
  const user = await loadSessionUser(s.user_id)
  if (!user) return null
  // Expiração deslizante (atualiza no máximo 1x por minuto por sessão).
  const last = touchCache.get(id) ?? 0
  // Sessão do fornecedor não desliza: vale no máximo as 2 horas definidas ao entrar
  if (!s.mfa_pending && !s.impersonated_by && Date.now() - last > 60_000) {
    if (touchCache.size > 20_000) touchCache.clear() // limite: muitas sessões não crescem a memória sem fim
    touchCache.set(id, Date.now())
    const sec = await getSetting('security', { sessionHours: 12 })
    void q(
      `UPDATE user_sessions SET last_seen_at=now(), expires_at=greatest(expires_at, now() + ($2 || ' hours')::interval) WHERE id=$1`,
      [id, String(sec.sessionHours)],
    ).catch(() => {})
    void q(`UPDATE users SET last_seen_at=now() WHERE id=$1`, [user.id]).catch(() => {})
  }
  const impersonation = s.impersonated_by
    ? { by: s.impersonated_by, byName: s.impersonated_by_name, reason: s.impersonation_reason, expiresAt: new Date(s.expires_at).toISOString() }
    : null
  return { sessionId: id, user, mfaPending: s.mfa_pending, impersonation }
}

export async function revokeSession(sessionId: string) {
  await q(`UPDATE user_sessions SET revoked_at=now() WHERE id=$1`, [sessionId])
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  await q(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id <> coalesce($2,'')`, [
    userId,
    exceptSessionId ?? null,
  ])
}

export async function promoteSession(sessionId: string) {
  const sec = await getSetting('security', { sessionHours: 12 })
  await q(`UPDATE user_sessions SET mfa_pending=false, expires_at=now() + ($2 || ' hours')::interval WHERE id=$1`, [
    sessionId,
    String(sec.sessionHours),
  ])
}

// ---------------------------------------------------------------- login

export type LoginResult =
  | { ok: true; token: string; mfaRequired: boolean; mfaSetupRequired: boolean }
  | { ok: false; error: string; status: number }

export async function login(email: string, password: string, ip?: string, ua?: string): Promise<LoginResult> {
  const u = await one<any>(`SELECT * FROM users WHERE lower(email)=lower($1)`, [email.trim()])
  const generic: LoginResult = { ok: false, error: 'E-mail ou senha inválidos.', status: 401 }
  if (!u) {
    // Compara com um hash fictício para o tempo de resposta não revelar se o e-mail existe.
    dummyHash ??= await bcrypt.hash('nimber-atende-dummy', 12)
    await bcrypt.compare(password, dummyHash)
    return generic
  }
  if (!u.active) return { ok: false, error: 'Usuário desativado. Fale com o administrador.', status: 403 }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const min = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000)
    return { ok: false, error: `Acesso bloqueado por excesso de tentativas. Tente novamente em ${min} min.`, status: 429 }
  }
  const ok = await bcrypt.compare(password, u.password_hash)
  if (!ok) {
    const fails = u.failed_logins + 1
    await q(
      `UPDATE users SET failed_logins=$2, locked_until = CASE WHEN $2 >= $3 THEN now() + ($4 || ' minutes')::interval ELSE NULL END WHERE id=$1`,
      [u.id, fails, LOCK_THRESHOLD, String(LOCK_MINUTES)],
    )
    return generic
  }
  await q(`UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [u.id])
  const sec = await getSetting('security', { require2faAdmins: true, require2faAll: false })
  const mustHave2fa = sec.require2faAll || (sec.require2faAdmins && u.role === 'admin')
  const mfaRequired = !!u.totp_enabled
  const mfaSetupRequired = !u.totp_enabled && mustHave2fa
  const token = await createSession(u.id, mfaRequired, ip, ua)
  return { ok: true, token, mfaRequired, mfaSetupRequired }
}

// ---------------------------------------------------------------- 2FA

export async function beginTotpSetup(userId: string, email: string) {
  const secret = generateSecret()
  await q(`UPDATE users SET totp_secret_enc=$2 WHERE id=$1 AND NOT totp_enabled`, [userId, encryptSecret(secret)])
  return { secret, otpauth: otpauthUrl(secret, email, tenantOrNull()?.name || 'softIA') }
}

function makeRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase())
}

export async function confirmTotpSetup(userId: string, code: string): Promise<string[] | null> {
  const u = await one<any>(`SELECT totp_secret_enc FROM users WHERE id=$1`, [userId])
  if (!u?.totp_secret_enc) return null
  if (!verifyTotp(decryptSecret(u.totp_secret_enc), code)) return null
  const codes = makeRecoveryCodes()
  await q(`UPDATE users SET totp_enabled=true, recovery_codes=$2 WHERE id=$1`, [userId, JSON.stringify(codes.map((c) => sha256(c)))])
  return codes
}

export async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
  const u = await one<any>(`SELECT totp_secret_enc, recovery_codes FROM users WHERE id=$1 AND totp_enabled`, [userId])
  if (!u) return false
  const clean = code.trim()
  if (/^\d{6}$/.test(clean.replace(/\s/g, ''))) return verifyTotp(decryptSecret(u.totp_secret_enc), clean)
  // código de recuperação (uso único)
  const h = sha256(clean.toUpperCase())
  const list: string[] = u.recovery_codes ?? []
  if (!list.includes(h)) return false
  await q(`UPDATE users SET recovery_codes=$2 WHERE id=$1`, [userId, JSON.stringify(list.filter((x) => x !== h))])
  return true
}

export async function disableTotp(userId: string) {
  await q(`UPDATE users SET totp_enabled=false, totp_secret_enc=NULL, recovery_codes='[]' WHERE id=$1`, [userId])
}
