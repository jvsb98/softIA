/**
 * LGPD: retenção e eliminação de dados.
 *  - anonymizeContact: remove nome, telefone, e-mail, perfil de lead e o conteúdo das mensagens,
 *    preservando apenas o "esqueleto" estatístico (datas, setores, status).
 *  - runRetention: aplica a política configurada em Configurações → Retenção.
 */
import { q } from '../lib/db.js'
import { work, every } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { getSetting } from './settings.js'

export async function anonymizeContact(contactId: string) {
  await q(
    `UPDATE contacts SET name=NULL, push_name=NULL, phone=NULL, lid=NULL, email=NULL, notes=NULL, custom='{}',
            lead_profile='{}', score_breakdown='[]', anonymized_at=now(), opted_out=true, updated_at=now()
      WHERE id=$1`,
    [contactId],
  )
  await q(
    `UPDATE media_files SET data=NULL, deleted_at=now()
      WHERE id IN (SELECT m.media_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=$1 AND m.media_id IS NOT NULL)`,
    [contactId],
  )
  await q(
    `UPDATE messages SET body = CASE WHEN body IS NULL THEN NULL ELSE '[conteúdo removido — LGPD]' END, transcript=NULL, meta='{}'
      WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id=$1)`,
    [contactId],
  )
  await q(`UPDATE conversations SET status='closed', closed_at=coalesce(closed_at, now()), last_message_preview=NULL, context='{}', handoff_card=NULL WHERE contact_id=$1`, [contactId])
}

export async function runRetention() {
  const r = await getSetting('retention', { enabled: false, anonymizeClosedAfterDays: 730, deleteMediaAfterDays: 365 })
  if (!r.enabled) return
  const media = await q(
    `UPDATE media_files SET data=NULL, deleted_at=now() WHERE deleted_at IS NULL AND created_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(r.deleteMediaAfterDays)],
  )
  const stale = await q<{ id: string }>(
    `SELECT ct.id FROM contacts ct
      WHERE ct.anonymized_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id=ct.id AND (c.status<>'closed' OR c.closed_at > now() - ($1 || ' days')::interval))
        AND EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id=ct.id)
      LIMIT 500`,
    [String(r.anonymizeClosedAfterDays)],
  )
  for (const s of stale) await anonymizeContact(s.id)
  if (media.length || stale.length) log().info({ media: media.length, contacts: stale.length }, 'Política de retenção aplicada')
}

export function registerRetention() {
  work('ops.retention', async () => runRetention(), 1)
  every(6 * 60 * 60 * 1000, 'ops.retention')
}
