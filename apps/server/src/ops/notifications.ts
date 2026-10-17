/**
 * Alertas para a equipe de tecnologia (Slack via Incoming Webhook).
 * Ex.: número desconectado no celular, conexão com erro, bloqueio de compliance.
 */
import { log } from '../lib/logger.js'
import { getSetting } from './settings.js'

const lastSent = new Map<string, number>()

export async function notifyTeam(key: string, text: string, kind: 'connection' | 'compliance' | 'system' = 'system') {
  const cfg = await getSetting('notifications', { slackWebhookUrl: '', notifyConnectionDown: true, notifyComplianceBlock: true })
  if (!cfg.slackWebhookUrl) return
  if (kind === 'connection' && !cfg.notifyConnectionDown) return
  if (kind === 'compliance' && !cfg.notifyComplianceBlock) return
  // no máximo 1 alerta igual a cada 30 minutos
  const prev = lastSent.get(key) ?? 0
  if (Date.now() - prev < 30 * 60_000) return
  lastSent.set(key, Date.now())
  try {
    await fetch(cfg.slackWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*Nimber Atende* — ${text}` }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (err) {
    log().warn({ err: (err as Error).message }, 'Falha ao enviar alerta para o Slack')
  }
}
