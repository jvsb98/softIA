import { format, formatDistanceToNowStrict, isToday, isYesterday } from 'date-fns'
import { ptBR } from 'date-fns/locale'

export function formatPhone(p?: string | null) {
  const d = (p ?? '').replace(/\D/g, '')
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(4)
    return `+55 (${d.slice(2, 4)}) ${rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`}`
  }
  return d ? `+${d}` : ''
}

export function contactName(c?: { name?: string | null; push_name?: string | null; phone?: string | null } | null) {
  if (!c) return 'Contato'
  return c.name || c.push_name || formatPhone(c.phone) || 'Contato'
}

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '#'
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase()
}

export function listTime(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return 'ontem'
  return format(d, 'dd/MM', { locale: ptBR })
}

export function clock(iso?: string | null) {
  return iso ? format(new Date(iso), 'HH:mm') : ''
}

export function dayLabel(iso: string) {
  const d = new Date(iso)
  if (isToday(d)) return 'Hoje'
  if (isYesterday(d)) return 'Ontem'
  return format(d, "EEEE, d 'de' MMMM", { locale: ptBR })
}

export function ago(iso?: string | null) {
  if (!iso) return ''
  return formatDistanceToNowStrict(new Date(iso), { locale: ptBR, addSuffix: true })
}

export function dateTime(iso?: string | null) {
  return iso ? format(new Date(iso), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR }) : ''
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export const LEAD_STATUS: Record<string, string> = {
  novo: 'Novo',
  em_qualificacao: 'Em qualificação',
  qualificado: 'Qualificado',
  desqualificado: 'Desqualificado',
  cliente: 'Cliente',
}

export const CONV_STATUS: Record<string, string> = {
  automation: 'Automação',
  queued: 'Na fila',
  open: 'Em atendimento',
  closed: 'Encerrada',
}
