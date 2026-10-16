import { one, q } from '../lib/db.js'

const cache = new Map<string, { value: any; at: number }>()
const TTL = 10_000

export async function getSetting<T = any>(key: string, fallback: T): Promise<T> {
  const c = cache.get(key)
  if (c && Date.now() - c.at < TTL) return { ...fallback, ...c.value }
  const row = await one<{ value: any }>(`SELECT value FROM settings WHERE key=$1`, [key])
  const value = row?.value ?? {}
  cache.set(key, { value, at: Date.now() })
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) return { ...fallback, ...value }
  return (row ? value : fallback) as T
}

export async function setSetting(key: string, value: unknown, userId?: string | null) {
  await q(
    `INSERT INTO settings(key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId ?? null],
  )
  cache.delete(key)
}

export async function allSettings(): Promise<Record<string, any>> {
  const rows = await q<{ key: string; value: any }>(`SELECT key, value FROM settings`)
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}
