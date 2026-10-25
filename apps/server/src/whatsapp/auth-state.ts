/**
 * Estado de autenticação do Baileys guardado no PostgreSQL (tabela wa_auth_keys).
 * Substitui o useMultiFileAuthState do Extrator: a sessão sobrevive a reinstalação
 * e acompanha o banco na migração para a nuvem.
 */
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys'
import { q, tx } from '../lib/db.js'
import { currentCtx, NoContextError, runInCtx } from '../lib/tenant.js'

const serialize = (v: unknown) => JSON.stringify(v, BufferJSON.replacer)
const revive = (v: unknown) => JSON.parse(JSON.stringify(v), BufferJSON.reviver)

export async function usePostgresAuthState(connectionId: string): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
  clear: () => Promise<void>
}> {
  // O Baileys chama get/set de dentro dos próprios eventos: fixa o contexto do cliente dono da conexão.
  const ctx = currentCtx()
  if (!ctx) throw new NoContextError()
  const inCtx = <T>(fn: () => Promise<T>) => runInCtx(ctx, fn)
  const row = (await q(`SELECT value FROM wa_auth_keys WHERE connection_id=$1 AND category='creds' AND key_id=''`, [connectionId]))[0]
  const creds: AuthenticationCreds = row ? revive(row.value) : initAuthCreds()

  const saveCreds = () => inCtx(async () => {
    await q(
      `INSERT INTO wa_auth_keys(connection_id, category, key_id, value) VALUES ($1,'creds','',$2::jsonb)
       ON CONFLICT (connection_id, category, key_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [connectionId, serialize(creds)],
    )
  })

  const state: AuthenticationState = {
    creds,
    keys: {
      get: (type, ids) => inCtx(async () => {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
        if (!ids.length) return out
        const rows = await q<{ key_id: string; value: unknown }>(
          `SELECT key_id, value FROM wa_auth_keys WHERE connection_id=$1 AND category=$2 AND key_id = ANY($3)`,
          [connectionId, type, ids],
        )
        for (const r of rows) {
          let value = revive(r.value)
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
          out[r.key_id] = value
        }
        return out
      }),
      set: (data) => inCtx(() => tx(async (client) => {
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const entries = data[category] ?? {}
            for (const id of Object.keys(entries)) {
              const value = (entries as any)[id]
              if (value) {
                await client.query(
                  `INSERT INTO wa_auth_keys(connection_id, category, key_id, value) VALUES ($1,$2,$3,$4::jsonb)
                   ON CONFLICT (connection_id, category, key_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
                  [connectionId, category, id, serialize(value)],
                )
              } else {
                await client.query(`DELETE FROM wa_auth_keys WHERE connection_id=$1 AND category=$2 AND key_id=$3`, [connectionId, category, id])
              }
            }
          }
        })),
    },
  }

  const clear = () => inCtx(async () => {
    await q(`DELETE FROM wa_auth_keys WHERE connection_id=$1`, [connectionId])
  })

  return { state, saveCreds, clear }
}

/** Sessão que nunca pareou (QR lido com falha ou expirado) deve ser descartada antes de um novo QR. */
export async function discardUnpairedSession(connectionId: string) {
  const row = (await q(`SELECT value FROM wa_auth_keys WHERE connection_id=$1 AND category='creds' AND key_id=''`, [connectionId]))[0]
  if (!row) return false
  const creds = revive(row.value) as AuthenticationCreds
  if (creds.me) return false
  await q(`DELETE FROM wa_auth_keys WHERE connection_id=$1`, [connectionId])
  return true
}
