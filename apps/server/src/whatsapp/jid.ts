import { isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, isPnUser, jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys'
import { one, q } from '../lib/db.js'

export const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

export function isIgnorableJid(jid?: string | null): boolean {
  if (!jid) return true
  return !!(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || jid === 'status@broadcast' || jid.endsWith('@call'))
}

export function phoneFromPnJid(jid?: string | null): string | null {
  if (!jid || !isPnUser(jid)) return null
  return jidDecode(jid)?.user ?? null
}

export function lidOf(jid?: string | null): string | null {
  if (!jid || !isLidUser(jid)) return null
  return jidNormalizedUser(jid)
}

/** Converte telefone (com ou sem DDI) para JID de usuário. Números brasileiros sem DDI recebem 55. */
export function phoneToJid(phone: string): string {
  let d = digits(phone)
  if (d.length === 10 || d.length === 11) d = '55' + d
  return `${d}@s.whatsapp.net`
}

export async function rememberLid(lid: string, pn: string) {
  const l = jidNormalizedUser(lid)
  const p = digits(jidDecode(pn)?.user ?? pn)
  if (!l || !p) return
  await q(
    `INSERT INTO lid_map(lid, pn) VALUES ($1,$2) ON CONFLICT (lid) DO UPDATE SET pn=EXCLUDED.pn, updated_at=now()`,
    [l, p],
  )
  // Se já existir um contato só com LID, vincula o telefone a ele (sem duplicar contatos).
  await q(
    `UPDATE contacts SET phone=$2, updated_at=now()
      WHERE lid=$1 AND phone IS NULL AND NOT EXISTS (SELECT 1 FROM contacts c2 WHERE c2.phone=$2)`,
    [l, p],
  )
}

export async function phoneForLid(lid: string): Promise<string | null> {
  const r = await one<{ pn: string }>(`SELECT pn FROM lid_map WHERE lid=$1`, [jidNormalizedUser(lid)])
  return r?.pn ?? null
}

/** Formata número brasileiro para exibição: +55 (41) 99999-8888 */
export function formatPhone(p?: string | null): string {
  const d = digits(p)
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4)
    const rest = d.slice(4)
    return `+55 (${ddd}) ${rest.length === 9 ? rest.slice(0, 5) + '-' + rest.slice(5) : rest.slice(0, 4) + '-' + rest.slice(4)}`
  }
  return d ? `+${d}` : ''
}
