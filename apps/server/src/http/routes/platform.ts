/**
 * API do painel do fornecedor (hostname da plataforma) e da marca de cada ambiente (/api/brand).
 *
 * Perfis da equipe: admin (super admin), implantador, suporte.
 *   - criar cliente, módulos, limites, marca: admin e implantador
 *   - situação do cliente (suspender, reativar, cancelar), equipe: só admin
 *   - entrar como cliente: todos (suporte com motivo obrigatório)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { checkPasswordPolicy, disableTotp, hashPassword, revokeAllSessions } from '../../auth/service.js'
import { randomToken, sha256 } from '../../lib/crypto.js'
import { loadConfig } from '../../lib/config.js'
import { one, q } from '../../lib/db.js'
import { tenantOrNull, withPlatform, withTenant, type TenantCtx } from '../../lib/tenant.js'
import { audit } from '../../ops/audit.js'
import { publishPlatformEvent } from '../../platform/events.js'
import { DEFAULT_LIMITS, limitsOf, MODULES, modulesView, PLAN_PRESETS } from '../../platform/modules.js'
import { createTenant, getTenant, invalidateHosts, setTenantStatus, tenantUrl, validateSlug } from '../../platform/tenants.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { clientIp, currentUser } from '../app.js'

type PlatformRole = 'admin' | 'implantador' | 'suporte'

export const ROLE_LABEL: Record<PlatformRole, string> = { admin: 'Super admin', implantador: 'Implantador', suporte: 'Suporte' }

function requireStaff(req: FastifyRequest, ...roles: PlatformRole[]) {
  if (req.execCtx?.kind !== 'platform') throw notFound()
  const u = currentUser(req)
  if (roles.length && !roles.includes(u.role as PlatformRole)) throw forbidden('Seu perfil não permite esta ação.')
  return u
}

export const SEGMENTS = [
  { key: 'marmoraria', label: 'Marmoraria' },
  { key: 'clinica', label: 'Clínica' },
  { key: 'consultorio', label: 'Consultório' },
  { key: 'outro', label: 'Outro' },
]

const uuid = z.string().uuid()
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use uma cor no formato #RRGGBB')
const moduleState = z.object({ enabled: z.boolean(), config: z.record(z.string(), z.any()).default({}) })
const limitsBody = z.object({
  maxConnections: z.number().int().min(0).max(100),
  maxUsers: z.number().int().min(1).max(1000),
  maxProfessionals: z.number().int().min(0).max(1000),
  aiTokensMonth: z.number().int().min(0).max(1_000_000_000),
  aiOverage: z.enum(['bloquear', 'avisar']),
})
const brandBody = z.object({ productName: z.string().trim().max(40).optional().or(z.literal('')), primaryColor: color.optional().or(z.literal('')) })

/** Linha do cliente com dados de plataforma (para telas). */
async function tenantRow(id: string) {
  return withPlatform(() =>
    one<any>(
      `SELECT t.*, (SELECT string_agg(hostname, ', ') FROM domains d WHERE d.tenant_id=t.id) AS hosts,
              (SELECT name FROM users u WHERE u.id=t.created_by) AS created_by_name,
              EXISTS (SELECT 1 FROM brand_assets b WHERE b.tenant_id=t.id AND b.kind='logo') AS has_logo,
              coalesce((SELECT jsonb_object_agg(m.module, jsonb_build_object('enabled', m.enabled, 'config', m.config)) FROM tenant_modules m WHERE m.tenant_id=t.id), '{}'::jsonb) AS modules
         FROM tenants t WHERE t.id=$1`,
      [id],
    ),
  )
}

const MONTH_START = `date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`

/** Situação operacional de um cliente (consulta no schema dele). */
async function tenantHealth(t: TenantCtx) {
  try {
    return await withTenant(t, async () => {
      const conns = await q<any>(`SELECT id, name, status, phone, enabled, last_connected_at, last_error FROM connections ORDER BY created_at`)
      const users = await one<any>(
        `SELECT count(*) FILTER (WHERE active)::int AS active, max(last_seen_at) AS last_seen FROM users WHERE platform_user_id IS NULL`,
      )
      const open = await one<any>(`SELECT count(*)::int AS n FROM conversations WHERE status IN ('queued','open','automation')`)
      return { connections: conns, activeUsers: users?.active ?? 0, lastSeen: users?.last_seen ?? null, openConversations: open?.n ?? 0 }
    })
  } catch {
    return { connections: [], activeUsers: 0, lastSeen: null, openConversations: 0, error: 'Não foi possível ler o ambiente deste cliente.' }
  }
}

async function aiUsageByTenant(): Promise<Map<string, number>> {
  const rows = await withPlatform(() =>
    q<any>(
      `SELECT tenant_id, coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0)::bigint AS n
         FROM ai_usage WHERE created_at >= ${MONTH_START} GROUP BY tenant_id`,
    ),
  )
  return new Map(rows.map((r) => [r.tenant_id, Number(r.n)]))
}

async function changed(tenantId: string) {
  invalidateHosts()
  await publishPlatformEvent({ type: 'hosts.changed' })
  void tenantId
}

export async function platformRoutes(app: FastifyInstance) {
  // ============================================================ catálogo (módulos, planos, segmentos)
  app.get('/api/platform/catalog', async (req) => {
    requireStaff(req)
    return { modules: MODULES, plans: PLAN_PRESETS, segments: SEGMENTS, defaultLimits: DEFAULT_LIMITS, baseDomain: loadConfig().server.baseDomain, roles: ROLE_LABEL }
  })

  app.get('/api/platform/slug-check', async (req) => {
    requireStaff(req)
    const { slug } = z.object({ slug: z.string().max(60) }).parse(req.query)
    const s = slug.trim().toLowerCase()
    const err = validateSlug(s)
    if (err) return { ok: false, error: err }
    const taken = await withPlatform(() => one(`SELECT 1 FROM tenants WHERE slug=$1`, [s]))
    if (taken) return { ok: false, error: 'Já existe um cliente com este endereço.' }
    return { ok: true, host: `${s}.${loadConfig().server.baseDomain}` }
  })

  // ============================================================ clientes
  app.get('/api/platform/tenants', async (req) => {
    requireStaff(req)
    const rows = await withPlatform(() =>
      q<any>(
        `SELECT t.id, t.slug, t.name, t.status, t.segment, t.plan, t.limits, t.created_at,
                (SELECT string_agg(hostname, ', ') FROM domains d WHERE d.tenant_id=t.id) AS hosts,
                coalesce((SELECT jsonb_object_agg(m.module, jsonb_build_object('enabled', m.enabled, 'config', m.config)) FROM tenant_modules m WHERE m.tenant_id=t.id), '{}'::jsonb) AS modules
           FROM tenants t ORDER BY (t.status='cancelado'), t.created_at DESC`,
      ),
    )
    const usage = await aiUsageByTenant()
    return Promise.all(
      rows.map(async (r) => {
        const t = (await getTenant(r.id))!
        const health = r.status === 'cancelado' ? { connections: [], activeUsers: 0, lastSeen: null, openConversations: 0 } : await tenantHealth(t)
        const limits = limitsOf(r)
        return {
          ...r,
          limits,
          url: tenantUrl(r.slug),
          modules: modulesView(r),
          aiTokensMonth: usage.get(r.id) ?? 0,
          connections: health.connections.map((c: any) => ({ name: c.name, status: c.status, enabled: c.enabled, lastConnectedAt: c.last_connected_at })),
          activeUsers: health.activeUsers,
          lastSeen: health.lastSeen,
          openConversations: health.openConversations,
        }
      }),
    )
  })

  const createBody = z.object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().trim().min(1).max(40),
    segment: z.string().max(40).nullable().optional(),
    plan: z.string().max(40).default('essencial'),
    modules: z.record(z.string(), moduleState).default({}),
    limits: limitsBody.partial().default({}),
    brand: brandBody.default({}),
    admin: z.object({ name: z.string().trim().min(2).max(120), email: z.string().email() }),
    contact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(40).optional(), email: z.string().max(160).optional() }).default({}),
    notes: z.string().max(4000).nullable().optional(),
  })

  app.post('/api/platform/tenants', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const b = createBody.parse(req.body)
    const modules = Object.fromEntries(Object.entries(b.modules).filter(([k]) => MODULES.some((m) => m.key === k && !m.base)))
    let r
    try {
      r = await createTenant({
        slug: b.slug,
        name: b.name,
        segment: b.segment ?? null,
        plan: b.plan,
        modules,
        limits: b.limits,
        brand: { productName: b.brand.productName || undefined, primaryColor: b.brand.primaryColor || undefined },
        contact: b.contact,
        notes: b.notes ?? null,
        adminName: b.admin.name,
        adminEmail: b.admin.email,
        createdBy: me.id,
      })
    } catch (err: any) {
      throw badRequest(err?.message ?? 'Não foi possível criar o cliente.')
    }
    await audit({ userId: me.id, action: 'cliente.criado', entity: 'tenant', entityId: r.tenant.id, data: { slug: r.tenant.slug, plano: b.plan }, ip: clientIp(req) })
    const productName = b.brand.productName || 'o sistema de atendimento'
    const whatsappMessage =
      `Olá, ${b.admin.name.split(' ')[0]}! Seu acesso a ${productName} está pronto.\n\n` +
      `Endereço: ${r.url}\nE-mail: ${r.adminEmail}\nSenha temporária: ${r.temporaryPassword}\n\n` +
      `No primeiro acesso você cria a sua senha e ativa a verificação em duas etapas.`
    return { id: r.tenant.id, slug: r.tenant.slug, url: r.url, adminEmail: r.adminEmail, temporaryPassword: r.temporaryPassword, whatsappMessage }
  })

  app.get('/api/platform/tenants/:id', async (req) => {
    requireStaff(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const r = await tenantRow(id)
    if (!r) throw notFound()
    const t = (await getTenant(id))!
    const health = r.status === 'cancelado' ? null : await tenantHealth(t)
    const used = (await aiUsageByTenant()).get(id) ?? 0
    const recent =
      r.status === 'cancelado'
        ? []
        : await withTenant(t, () =>
            q<any>(
              `SELECT a.action, a.created_at, u.name AS user_name, a.data FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                ORDER BY a.id DESC LIMIT 15`,
            ),
          ).catch(() => [])
    return {
      ...r,
      limits: limitsOf(r),
      url: tenantUrl(r.slug),
      modules: modulesView(r),
      logoUrl: r.has_logo ? `/api/platform/tenants/${id}/brand/logo?v=${Date.parse(r.updated_at) || 0}` : null,
      usage: { aiTokensMonth: used },
      health,
      recentActivity: recent,
    }
  })

  app.put('/api/platform/tenants/:id', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z
      .object({
        name: z.string().trim().min(2).max(120),
        segment: z.string().max(40).nullable().optional(),
        plan: z.string().max(40).nullable().optional(),
        contact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(40).optional(), email: z.string().max(160).optional() }).default({}),
        notes: z.string().max(4000).nullable().optional(),
      })
      .parse(req.body)
    await withPlatform(() =>
      q(`UPDATE tenants SET name=$2, segment=$3, plan=coalesce($4, plan), contact=$5, notes=$6, updated_at=now() WHERE id=$1`, [
        id,
        b.name,
        b.segment ?? null,
        b.plan ?? null,
        JSON.stringify(b.contact),
        b.notes ?? null,
      ]),
    )
    await changed(id)
    await audit({ userId: me.id, action: 'cliente.dados_alterados', entity: 'tenant', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.put('/api/platform/tenants/:id/modules', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = z.object({ modules: z.record(z.string(), moduleState) }).parse(req.body)
    if (!(await tenantRow(id))) throw notFound()
    const changedKeys: string[] = []
    await withPlatform(async () => {
      for (const [key, m] of Object.entries(b.modules)) {
        const def = MODULES.find((x) => x.key === key)
        if (!def || def.base) continue
        if (key === 'fluxos' && m.config.edicao && !['fornecedor', 'cliente_edita', 'cliente_cria'].includes(m.config.edicao)) throw badRequest('Modo de edição de fluxos inválido.')
        await q(
          `INSERT INTO tenant_modules(tenant_id, module, enabled, config, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id, module) DO UPDATE SET enabled=EXCLUDED.enabled, config=EXCLUDED.config, updated_by=EXCLUDED.updated_by, updated_at=now()`,
          [id, key, m.enabled, JSON.stringify(m.config ?? {}), me.id],
        )
        changedKeys.push(`${key}:${m.enabled ? 'on' : 'off'}`)
      }
    })
    await changed(id)
    await audit({ userId: me.id, action: 'cliente.modulos_alterados', entity: 'tenant', entityId: id, data: { modulos: changedKeys }, ip: clientIp(req) })
    return { ok: true }
  })

  app.put('/api/platform/tenants/:id/limits', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = limitsBody.parse(req.body)
    await withPlatform(() => q(`UPDATE tenants SET limits=$2, updated_at=now() WHERE id=$1`, [id, JSON.stringify(b)]))
    await changed(id)
    await audit({ userId: me.id, action: 'cliente.limites_alterados', entity: 'tenant', entityId: id, data: b, ip: clientIp(req) })
    return { ok: true }
  })

  app.put('/api/platform/tenants/:id/brand', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = brandBody.parse(req.body)
    const brand = { productName: b.productName || undefined, primaryColor: b.primaryColor || undefined }
    await withPlatform(() => q(`UPDATE tenants SET brand = brand || $2::jsonb, updated_at=now() WHERE id=$1`, [id, JSON.stringify(brand)]))
    await audit({ userId: me.id, action: 'cliente.marca_alterada', entity: 'tenant', entityId: id, data: brand, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/platform/tenants/:id/brand/logo', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const file = await (req as any).file()
    if (!file) throw badRequest('Envie a imagem do logo.')
    // Só imagens de bitmap: SVG pode carregar script
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) throw badRequest('Use PNG, JPG ou WEBP.')
    const buf: Buffer = await file.toBuffer()
    if (buf.length > 300 * 1024) throw badRequest('O logo pode ter no máximo 300 KB.')
    await withPlatform(async () => {
      await q(
        `INSERT INTO brand_assets(tenant_id, kind, mime, data) VALUES ($1,'logo',$2,$3)
         ON CONFLICT (tenant_id, kind) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`,
        [id, file.mimetype, buf],
      )
      await q(`UPDATE tenants SET updated_at=now() WHERE id=$1`, [id])
    })
    await audit({ userId: me.id, action: 'cliente.logo_alterado', entity: 'tenant', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.delete('/api/platform/tenants/:id/brand/logo', async (req) => {
    const me = requireStaff(req, 'admin', 'implantador')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await withPlatform(() => q(`DELETE FROM brand_assets WHERE tenant_id=$1 AND kind='logo'`, [id]))
    await audit({ userId: me.id, action: 'cliente.logo_removido', entity: 'tenant', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  app.get('/api/platform/tenants/:id/brand/logo', async (req, reply) => {
    requireStaff(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const a = await withPlatform(() => one<any>(`SELECT mime, data FROM brand_assets WHERE tenant_id=$1 AND kind='logo'`, [id]))
    if (!a) throw notFound()
    return reply.header('Content-Type', a.mime).header('Cache-Control', 'private, max-age=300').header('X-Content-Type-Options', 'nosniff').send(a.data)
  })

  app.post('/api/platform/tenants/:id/status', async (req) => {
    const me = requireStaff(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { status } = z.object({ status: z.enum(['implantacao', 'ativo', 'suspenso', 'cancelado']) }).parse(req.body)
    const r = await tenantRow(id)
    if (!r) throw notFound()
    await setTenantStatus(id, status)
    await audit({ userId: me.id, action: 'cliente.situacao_alterada', entity: 'tenant', entityId: id, data: { de: r.status, para: status }, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ entrar como cliente
  app.post('/api/platform/tenants/:id/impersonate', async (req) => {
    const me = requireStaff(req)
    const { id } = z.object({ id: uuid }).parse(req.params)
    const { reason } = z.object({ reason: z.string().trim().max(300).default('') }).parse(req.body)
    if ((me.role as string) === 'suporte' && reason.length < 5) throw badRequest('Informe o motivo do acesso (obrigatório para o perfil Suporte).')
    const r = await tenantRow(id)
    if (!r) throw notFound()
    if (r.status === 'suspenso' || r.status === 'cancelado') throw badRequest('Reative o cliente antes de entrar no ambiente dele.')
    const token = randomToken(32)
    await withPlatform(() =>
      q(`INSERT INTO impersonation_tokens(id, tenant_id, platform_user_id, reason, expires_at) VALUES ($1,$2,$3,$4, now() + interval '60 seconds')`, [
        sha256(token),
        id,
        me.id,
        reason || null,
      ]),
    )
    await audit({ userId: me.id, action: 'cliente.acesso_fornecedor', entity: 'tenant', entityId: id, data: { slug: r.slug, motivo: reason || null }, ip: clientIp(req) })
    return { url: `${tenantUrl(r.slug)}/api/auth/impersonate?token=${encodeURIComponent(token)}` }
  })

  // ============================================================ equipe do fornecedor
  app.get('/api/platform/team', async (req) => {
    requireStaff(req)
    return q(
      `SELECT id, name, email, role, active, totp_enabled, last_login_at, last_seen_at, created_at, locked_until FROM users ORDER BY active DESC, name`,
    )
  })

  const teamBody = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email(), role: z.enum(['admin', 'implantador', 'suporte']), active: z.boolean().default(true) })

  app.post('/api/platform/team', async (req) => {
    const me = requireStaff(req, 'admin')
    const b = teamBody.parse(req.body)
    if (await one(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [b.email])) throw badRequest('Já existe alguém com este e-mail.')
    const temp = `Temp-${randomToken(8)}1`
    const u = await one<any>(
      `INSERT INTO users(name, email, password_hash, role, active, must_change_password) VALUES ($1, lower($2), $3, $4, $5, true) RETURNING id`,
      [b.name, b.email, await hashPassword(temp), b.role, b.active],
    )
    await audit({ userId: me.id, action: 'equipe.criado', entity: 'user', entityId: u.id, data: { email: b.email, perfil: b.role }, ip: clientIp(req) })
    return { id: u.id, temporaryPassword: temp }
  })

  app.put('/api/platform/team/:id', async (req) => {
    const me = requireStaff(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const b = teamBody.parse(req.body)
    if (id === me.id && (b.role !== 'admin' || !b.active)) throw badRequest('Você não pode remover o seu próprio acesso de super admin.')
    await q(`UPDATE users SET name=$2, email=lower($3), role=$4, active=$5, updated_at=now() WHERE id=$1`, [id, b.name, b.email, b.role, b.active])
    if (!b.active) await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'equipe.alterado', entity: 'user', entityId: id, data: { perfil: b.role, ativo: b.active }, ip: clientIp(req) })
    return { ok: true }
  })

  app.post('/api/platform/team/:id/reset-password', async (req) => {
    const me = requireStaff(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    const temp = `Temp-${randomToken(8)}1`
    const policy = await checkPasswordPolicy(temp)
    if (policy) throw badRequest(policy)
    await q(`UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL WHERE id=$1`, [id, await hashPassword(temp)])
    await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'equipe.senha_redefinida', entity: 'user', entityId: id, ip: clientIp(req) })
    return { temporaryPassword: temp }
  })

  app.post('/api/platform/team/:id/reset-2fa', async (req) => {
    const me = requireStaff(req, 'admin')
    const { id } = z.object({ id: uuid }).parse(req.params)
    await disableTotp(id)
    await revokeAllSessions(id)
    await audit({ userId: me.id, action: 'equipe.2fa_redefinido', entity: 'user', entityId: id, ip: clientIp(req) })
    return { ok: true }
  })

  // ============================================================ marca do ambiente (público)
  app.get('/api/brand', async () => {
    const t = tenantOrNull()
    const platformName = process.env.PLATFORM_BRAND_NAME || 'softIA'
    if (!t) return { scope: 'platform', productName: platformName, orgName: 'Painel do fornecedor', primaryColor: null, logoUrl: null }
    const r = await withPlatform(() =>
      one<any>(
        `SELECT t.name, t.brand, t.updated_at, EXISTS (SELECT 1 FROM brand_assets b WHERE b.tenant_id=t.id AND b.kind='logo') AS has_logo FROM tenants t WHERE t.id=$1`,
        [t.id],
      ),
    )
    const brand = r?.brand ?? {}
    return {
      scope: 'tenant',
      productName: brand.productName || r?.name || platformName,
      orgName: r?.name ?? '',
      primaryColor: brand.primaryColor || null,
      logoUrl: r?.has_logo ? `/api/brand/logo?v=${Date.parse(r.updated_at) || 0}` : null,
    }
  })

  app.get('/api/brand/logo', async (_req, reply) => {
    const t = tenantOrNull()
    if (!t) throw notFound()
    const a = await withPlatform(() => one<any>(`SELECT mime, data FROM brand_assets WHERE tenant_id=$1 AND kind='logo'`, [t.id]))
    if (!a) throw notFound()
    return reply.header('Content-Type', a.mime).header('Cache-Control', 'public, max-age=3600').header('X-Content-Type-Options', 'nosniff').send(a.data)
  })
}
