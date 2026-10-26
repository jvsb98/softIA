/**
 * Alertas para a equipe de tecnologia (Slack via Incoming Webhook).
 * Ex.: número desconectado no celular, conexão com erro, bloqueio de compliance.
 */
import { log } from '../lib/logger.js'
import { getSetting } from './settings.js'
import { safeFetch } from '../lib/net-guard.js'
import { ctxKey, tenantOrNull } from '../lib/tenant.js'
import { isModuleOn } from '../platform/modules.js'

const lastSent = new Map<string, number>()

export async function notifyTeam(key: string, text: string, kind: 'connection' | 'compliance' | 'system' = 'system') {
  if (!isModuleOn(tenantOrNull(), 'integracoes')) return
  const cfg = await getSetting('notifications', { slackWebhookUrl: '', notifyConnectionDown: true, notifyComplianceBlock: true })
  if (!cfg.slackWebhookUrl) return
  if (kind === 'connection' && !cfg.notifyConnectionDown) return
  if (kind === 'compliance' && !cfg.notifyComplianceBlock) return
  // no máximo 1 alerta igual a cada 30 minutos
  const prev = lastSent.get(ctxKey() + key) ?? 0
  if (Date.now() - prev < 30 * 60_000) return
  lastSent.set(ctxKey() + key, Date.now())
  try {
    await safeFetch(cfg.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*${tenantOrNull()?.name ?? 'softIA'}* — ${text}` }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    log().warn({ err: (err as Error).message }, 'Falha ao enviar alerta para o Slack')
  }
}
