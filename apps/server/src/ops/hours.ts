/**
 * Horário de atendimento por setor.
 * hours: { "0": [["09:00","12:00"]], "1": [["09:00","18:00"]], ... }  (0 = domingo … 6 = sábado)
 */
import { one } from '../lib/db.js'

export type WeeklyHours = Record<string, [string, string][]>

export interface HoursHolder {
  hours: WeeklyHours
  timezone: string
  hours_enabled: boolean
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function localParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const hour = parts.hour === '24' ? '00' : parts.hour
  return {
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
    minutes: Number(hour) * 60 + Number(parts.minute),
  }
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function isWithinHours(h: HoursHolder, date = new Date(), holidays: Set<string> = new Set()): boolean {
  if (!h.hours_enabled) return true
  const p = localParts(date, h.timezone || 'America/Sao_Paulo')
  if (holidays.has(p.date)) return false
  const ranges = h.hours?.[String(p.weekday)] ?? []
  return ranges.some(([a, b]) => p.minutes >= toMin(a) && p.minutes < toMin(b))
}

/** Próxima abertura (para mensagens como "retornaremos amanhã às 9h"). Procura até 14 dias à frente. */
export function nextOpening(h: HoursHolder, from = new Date(), holidays: Set<string> = new Set()): Date | null {
  if (!h.hours_enabled) return from
  for (let step = 0; step < 14 * 24 * 4; step++) {
    const d = new Date(from.getTime() + step * 15 * 60 * 1000)
    if (isWithinHours(h, d, holidays)) return d
  }
  return null
}

export async function holidaySet(): Promise<Set<string>> {
  try {
    const r = await one<{ days: string[] }>(
      `SELECT coalesce(array_agg(to_char(day,'YYYY-MM-DD')), '{}') AS days FROM holidays WHERE day BETWEEN current_date - 1 AND current_date + 30`,
    )
    return new Set(r?.days ?? [])
  } catch {
    return new Set() // tabela de feriados chega na fase 4
  }
}

export function describeHours(h: WeeklyHours): string {
  const names = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
  const parts: string[] = []
  for (let d = 0; d < 7; d++) {
    const r = h[String(d)]
    if (r?.length) parts.push(`${names[d]} ${r.map(([a, b]) => `${a}–${b}`).join(', ')}`)
  }
  return parts.join(' · ') || 'sem horário definido'
}
