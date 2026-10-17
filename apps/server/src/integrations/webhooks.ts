/**
 * Webhooks de saída: avisam o n8n, o CRM da intranet ou outro sistema quando algo acontece.
 * Cada entrega é assinada (X-Nimber-Signature: sha256=<hmac>) e tem novas tentativas.
 */
import { hmac } from '../lib/crypto.js'
import { one, q } from '../lib/db.js'
import { enqueue, work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { safeFetch } from '../lib/net-guard.js'

export const WEBHOOK_EVENTS: Record<string, string> = {
  'lead.qualified': 'Lead qualificado (com score e respostas)',
  'conversation.transferred': 'Conversa transferida para um setor/atendente',
  'conversation.closed': 'Conversa encerrada',
  'message.received': 'Mensagem recebida de um contato',
  'contact.opted_out': 'Contato pediu para não receber mensagens',
  'connection.connected': 'Número conectado',
  'connection.logged_out': 'Número desconectado no celular',
  'compliance.blocked': 'Resposta da IA bloqueada pelo compliance',
}

/** Enriquecimento: o CRM recebe contato e conversa completos, não só IDs. */
async function enrich(event: string, data: Record<string, any>) {
  const out: Record<string, any> = { ...data }
  if (data.conversationId) {
    const c = await one<any>(
      `SELECT c.id, c.status, c.handoff_reason, c.created_at, s.name AS sector, u.name AS assignee, cn.name AS connection,
              ct.id AS contact_id, ct.name, ct.push_name, ct.phone, ct.email, ct.lead_status, ct.score, ct.score_breakdown, ct.lead_profile, ct.origin, ct.is_customer
         FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN connections cn ON cn.id=c.connection_id
         LEFT JOIN sectors s ON s.id=c.sector_id LEFT JOIN users u ON u.id=c.assignee_id WHERE c.id=$1`,
      [data.conversationId],
    )
    if (c) {
      out.conversation = { id: c.id, status: c.status, sector: c.sector, assignee: c.assignee, connection: c.connection, reason: c.handoff_reason, createdAt: c.created_at }
      out.contact = {
        id: c.contact_id,
        name: c.name || c.push_name,
        phone: c.phone,
        email: c.email,
        leadStatus: c.lead_status,
        score: c.score,
        scoreBreakdown: c.score_breakdown,
        profile: c.lead_profile,
        origin: c.origin,
        isCustomer: c.is_customer,
      }
    }
  }
  return out
}

export async function fireEvent(event: string, data: Record<string, unknown>) {
  try {
    const hooks = await q<any>(`SELECT id FROM webhooks WHERE enabled AND ($1 = ANY(events) OR '*' = ANY(events))`, [event])
    if (!hooks.length) return
    const payload = { event, sentAt: new Date().toISOString(), data: await enrich(event, data as any) }
    for (const h of hooks) {
      const d = await one<any>(`INSERT INTO webhook_deliveries(webhook_id, event, payload) VALUES ($1,$2,$3) RETURNING id`, [h.id, event, JSON.stringify(payload)])
      await enqueue('webhook.deliver', { deliveryId: d.id }, { maxAttempts: 6 })
    }
  } catch (err) {
    log().warn({ err, event }, 'Falha ao enfileirar webhook')
  }
}

async function deliver(job: Job<{ deliveryId: number }>) {
  const d = await one<any>(`SELECT d.*, w.url, w.secret, w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id=d.webhook_id WHERE d.id=$1`, [job.payload.deliveryId])
  if (!d || !d.enabled || d.status === 'delivered') return
  const body = JSON.stringify(d.payload)
  let code: number | null = null
  try {
    const res = await safeFetch(d.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'NimberAtende-Webhook/1.0', 'x-nimber-event': d.event, 'x-nimber-signature': `sha256=${hmac(d.secret, body)}` },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    code = res.status
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await q(`UPDATE webhook_deliveries SET status='delivered', attempts=attempts+1, response_code=$2, delivered_at=now(), error=NULL WHERE id=$1`, [d.id, code])
  } catch (err: any) {
    const last = job.attempts >= job.max_attempts
    await q(`UPDATE webhook_deliveries SET status=$2, attempts=attempts+1, response_code=$3, error=$4 WHERE id=$1`, [d.id, last ? 'failed' : 'pending', code, String(err?.message ?? err).slice(0, 300)])
    throw err
  }
}

export function registerWebhooks() {
  work('webhook.deliver', deliver, 4)
}
