/**
 * Avisos entre processos pela própria conexão do Postgres (LISTEN/NOTIFY no canal "softia_platform").
 * Ex.: o CLI (ou o painel, na Fase 2) suspende um cliente e o servidor que está rodando para as
 * conexões de WhatsApp e derruba os sockets daquele cliente na hora, sem reiniciar.
 */
import type pg from 'pg'
import { db, q } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { withPlatform } from '../lib/tenant.js'

export type PlatformEvent =
  | { type: 'tenant.created'; tenantId: string }
  | { type: 'tenant.status'; tenantId: string; status: string }
  | { type: 'hosts.changed' }

const CHANNEL = 'softia_platform'

export async function publishPlatformEvent(ev: PlatformEvent) {
  await withPlatform(() => q(`SELECT pg_notify($1, $2)`, [CHANNEL, JSON.stringify(ev)])).catch((err) =>
    log().warn({ err: (err as Error).message, ev }, 'Não foi possível avisar os servidores'),
  )
}

let client: pg.PoolClient | null = null

export async function listenPlatformEvents(handler: (ev: PlatformEvent) => Promise<void> | void) {
  client = await db().connect()
  await client.query(`LISTEN ${CHANNEL}`)
  client.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return
    let ev: PlatformEvent
    try {
      ev = JSON.parse(msg.payload)
    } catch {
      return
    }
    Promise.resolve(handler(ev)).catch((err) => log().error({ err, ev }, 'Falha ao tratar aviso da plataforma'))
  })
}

export async function stopPlatformEvents() {
  if (!client) return
  await client.query(`UNLISTEN ${CHANNEL}`).catch(() => {})
  client.release()
  client = null
}
