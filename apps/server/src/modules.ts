/**
 * Registro dos módulos do servidor (rotas, workers e ganchos).
 * Cada fase acrescenta seus módulos aqui.
 */
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from './lib/config.js'
import { adminRoutes } from './http/routes/admin.js'
import { authRoutes } from './http/routes/auth.js'
import { inboxRoutes } from './http/routes/inbox.js'
import { registerAutomationWorker } from './inbox/automation.js'
import { registerOutboundWorker } from './inbox/outbound.js'
import { registerRetention } from './ops/retention.js'
import { aiRoutes } from './http/routes/ai.js'
import { registerAi } from './ai/automation.js'
import { flowRoutes } from './http/routes/flows.js'
import { registerFlowRuntime } from './flows/runtime.js'

export async function registerModules(app: FastifyInstance, cfg: AppConfig) {
  const secure = cfg.server.publicUrl.startsWith('https://')
  app.get('/api/health', async () => ({ ok: true, app: 'nimber-atende', version: process.env.npm_package_version ?? '1.0.0', time: new Date().toISOString() }))
  await authRoutes(app, secure)
  await adminRoutes(app)
  await inboxRoutes(app)
  await aiRoutes(app)
  await flowRoutes(app)

  registerOutboundWorker()
  registerAutomationWorker()
  registerRetention()
  registerAi()
  registerFlowRuntime()
}
