/**
 * Qualificação híbrida: a IA só EXTRAI os valores dos critérios; a pontuação é calculada
 * aqui, de forma determinística, pelas regras cadastradas (critério × peso × corte).
 */
import { one, q } from '../lib/db.js'
import { getSetting } from '../ops/settings.js'

export interface Criterion {
  id: string
  key: string
  label: string
  question: string
  description: string
  type: 'choice' | 'number' | 'boolean' | 'text'
  options: any
  weight: number
  required: boolean
  disqualify_values: any[]
  sort: number
}

export interface ScoreLine {
  key: string
  label: string
  value: any
  display: string
  points: number
}

export async function activeCriteria(): Promise<Criterion[]> {
  return q<Criterion>(`SELECT * FROM qualification_criteria WHERE active ORDER BY sort, label`)
}

function pointsFor(c: Criterion, value: any): { points: number; display: string } | null {
  if (value === undefined || value === null || value === '') return null
  if (c.type === 'choice') {
    const opt = (c.options as any[]).find((o) => String(o.value) === String(value))
    if (!opt) return null
    return { points: Number(opt.points ?? 0), display: opt.label ?? String(value) }
  }
  if (c.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    const band = (c.options as any[]).find((b) => (b.min == null || n >= Number(b.min)) && (b.max == null || n <= Number(b.max)))
    return { points: Number(band?.points ?? 0), display: n.toLocaleString('pt-BR') }
  }
  if (c.type === 'boolean') {
    const b = value === true || value === 'true' || value === 'sim'
    return { points: Number((c.options ?? {})[String(b)] ?? 0), display: b ? 'Sim' : 'Não' }
  }
  return { points: 0, display: String(value).slice(0, 200) }
}

export function computeScore(criteria: Criterion[], profile: Record<string, any>) {
  const lines: ScoreLine[] = []
  let total = 0
  let disqualifiedBy: string | null = null
  for (const c of criteria) {
    const v = profile[c.key]
    const p = pointsFor(c, v)
    if (!p) continue
    const pts = Math.round(p.points * Number(c.weight ?? 1))
    total += pts
    lines.push({ key: c.key, label: c.label, value: v, display: p.display, points: pts })
    if ((c.disqualify_values ?? []).map(String).includes(String(v))) disqualifiedBy = `${c.label}: ${p.display}`
  }
  const missing = criteria.filter((c) => c.required && pointsFor(c, profile[c.key]) === null)
  return { total, lines, missing, disqualifiedBy }
}

export function criteriaToolSchema(criteria: Criterion[]) {
  const props: Record<string, any> = {}
  for (const c of criteria) {
    const desc = `${c.label}. ${c.description}`.trim()
    if (c.type === 'choice') props[c.key] = { type: 'string', enum: (c.options as any[]).map((o) => String(o.value)), description: `${desc} Opções: ${(c.options as any[]).map((o) => `${o.value} = ${o.label}`).join('; ')}` }
    else if (c.type === 'number') props[c.key] = { type: 'number', description: desc }
    else if (c.type === 'boolean') props[c.key] = { type: 'boolean', description: desc }
    else props[c.key] = { type: 'string', description: desc }
  }
  return {
    type: 'object',
    properties: { valores: { type: 'object', properties: props, description: 'Somente os critérios que o contato respondeu de forma clara nesta conversa.' } },
    required: ['valores'],
  }
}

/**
 * Registra valores extraídos pela IA no perfil do contato e recalcula o score.
 * Retorna o que a IA precisa saber para continuar (próxima pergunta, se já qualificou).
 */
export async function applyCriteria(contactId: string, values: Record<string, any>) {
  const criteria = await activeCriteria()
  const settings = await getSetting('qualification', { enabled: true, threshold: 22, targetSectorSlug: 'closer', disqualifyBelow: null as number | null })
  const contact = await one<any>(`SELECT lead_profile, lead_status FROM contacts WHERE id=$1`, [contactId])
  const profile = { ...(contact?.lead_profile ?? {}) }
  const valid = new Set(criteria.map((c) => c.key))
  for (const [k, v] of Object.entries(values ?? {})) if (valid.has(k) && v !== null && v !== undefined && v !== '') profile[k] = v
  const r = computeScore(criteria, profile)
  const complete = r.missing.length === 0
  const qualified = settings.enabled && r.total >= settings.threshold
  const disqualified = !qualified && (!!r.disqualifiedBy || (complete && settings.disqualifyBelow != null && r.total < settings.disqualifyBelow))
  const status = contact?.lead_status === 'cliente' ? 'cliente' : qualified ? 'qualificado' : disqualified ? 'desqualificado' : Object.keys(profile).length ? 'em_qualificacao' : 'novo'
  await q(`UPDATE contacts SET lead_profile=$2, score=$3, score_breakdown=$4, lead_status=$5, updated_at=now() WHERE id=$1`, [
    contactId,
    JSON.stringify(profile),
    r.lines.length ? r.total : null,
    JSON.stringify(r.lines),
    status,
  ])
  return {
    score: r.total,
    threshold: settings.threshold,
    qualified,
    disqualified,
    disqualifiedBy: r.disqualifiedBy,
    complete,
    breakdown: r.lines,
    next: r.missing[0] ?? null,
    targetSectorSlug: settings.targetSectorSlug,
  }
}
