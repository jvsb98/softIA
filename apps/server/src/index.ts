/**
 * softIA — servidor
 */
import { loadConfig } from './lib/config.js'
import { setMasterKey } from './lib/crypto.js'
import { createPool, migrate } from './lib/db.js'
import { setJobContextResolver, setRecurringTenantLister, startJobs, stopJobs } from './lib/jobs.js'
import { createLogger } from './lib/logger.js'
import { buildApp } from './http/app.js'
import { registerModules } from './modules.js'
import { manager } from './whatsapp/manager.js'
import { getTenant, getTenantCached, invalidateHosts, listRunningTenants } from './platform/tenants.js'
import { listenPlatformEvents, stopPlatformEvents } from './platform/events.js'
import { withTenant } from './lib/tenant.js'
import { disconnectTenantSockets, initRealtime } from './http/realtime.js'

async function main() {
  let cfg
  try {
    cfg = loadConfig()
  } catch (err) {
    console.error(`\n[softIA] ${(err as Error).message}\n`)
    process.exit(2)
  }
  const log = createLogger(cfg.server.logLevel, cfg.server.dataDir)
  log.info({ configDir: cfg.configDir, db: `${cfg.database.user}@${cfg.database.host}:${cfg.database.port}/${cfg.database.database}` }, 'Iniciando softIA')
  setMasterKey(cfg.masterKey)

  createPool(cfg.database)
  // Espera o banco ficar disponível (o PostgreSQL pode subir depois do serviço no boot do Windows)
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate()
      break
    } catch (err: any) {
      if (attempt >= 30 || !['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P03'].includes(err?.code)) {
        log.fatal({ err }, 'Não foi possível preparar o banco de dados. Confira o database.txt.')
        process.exit(3)
      }
      log.warn(`Banco indisponível (${err.code}); tentativa ${attempt}/30 em 5s...`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  const app = await buildApp(cfg)
  await registerModules(app, cfg)
  await app.listen({ port: cfg.server.port, host: cfg.server.host })
  initRealtime(app.server, (app as any).allowedOrigin)
  // Fila: cada tarefa roda no contexto do cliente dono; recorrentes (every) rodam para cada cliente ativo
  setJobContextResolver(async (id) => {
    const t = await getTenantCached(id)
    if (!t || t.status === 'cancelado') return 'gone'
    return t.status === 'ativo' || t.status === 'implantacao' ? t : null
  })
  setRecurringTenantLister(listRunningTenants)
  await startJobs()
  await manager.startAll(await listRunningTenants())

  // Avisos de outros processos (CLI, painel): suspensão para o WhatsApp e derruba os sockets na hora
  await listenPlatformEvents(async (ev) => {
    invalidateHosts()
    if (ev.type !== 'tenant.status') return
    const t = await getTenant(ev.tenantId)
    if (!t) return
    if (t.status === 'suspenso' || t.status === 'cancelado') {
      await withTenant(t, () => manager.stopTenant())
      disconnectTenantSockets(t.id)
      log.info({ tenant: t.slug, status: t.status }, 'Cliente parado neste servidor')
    } else {
      await withTenant(t, () => manager.startTenant())
      log.info({ tenant: t.slug, status: t.status }, 'Cliente retomado neste servidor')
    }
  })
  log.info(`softIA disponível em ${cfg.server.publicUrl} (porta ${cfg.server.port})`)

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log.info({ signal }, 'Encerrando...')
    const force = setTimeout(() => process.exit(0), 10_000)
    force.unref()
    await stopPlatformEvents().catch(() => {})
    await manager.stopAll().catch(() => {})
    await stopJobs().catch(() => {})
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (err) => log.error({ err }, 'Promise rejeitada sem tratamento'))
  process.on('uncaughtException', (err) => log.error({ err }, 'Exceção não tratada'))
}

void main()
