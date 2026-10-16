import { q } from '../lib/db.js'
import { log } from '../lib/logger.js'

export interface AuditInput {
  userId?: string | null
  action: string
  entity?: string
  entityId?: string | null
  data?: Record<string, unknown>
  ip?: string | null
}

/** Registra uma ação na trilha de auditoria. Nunca derruba a operação principal. */
export async function audit(a: AuditInput) {
  try {
    await q(`INSERT INTO audit_log(user_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6)`, [
      a.userId ?? null,
      a.action,
      a.entity ?? null,
      a.entityId ?? null,
      JSON.stringify(a.data ?? {}),
      a.ip ?? null,
    ])
  } catch (err) {
    log().warn({ err, action: a.action }, 'Falha ao gravar auditoria')
  }
}
