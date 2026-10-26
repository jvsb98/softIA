import { useQuery } from '@tanstack/react-query'
import { Badge, cx } from '../../components/ui'
import { api } from '../../lib/api'

export interface Catalog {
  modules: { key: string; label: string; description: string; base: boolean; available: boolean; phase?: string }[]
  plans: { key: string; label: string; description: string; modules: Record<string, { enabled: boolean; config: Record<string, any> }>; limits: Limits }[]
  segments: { key: string; label: string }[]
  defaultLimits: Limits
  baseDomain: string
}

export interface Limits {
  maxConnections: number
  maxUsers: number
  maxProfessionals: number
  aiTokensMonth: number
  aiOverage: 'bloquear' | 'avisar'
}

export const useCatalog = () => useQuery({ queryKey: ['platform-catalog'], queryFn: () => api.get<Catalog>('/api/platform/catalog'), staleTime: Infinity })

export const ROLE_LABEL: Record<string, string> = { admin: 'Super admin', implantador: 'Implantador', suporte: 'Suporte' }

export const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'coral' | 'neutral' }> = {
  implantacao: { label: 'Implantação', tone: 'warn' },
  ativo: { label: 'Ativo', tone: 'ok' },
  suspenso: { label: 'Suspenso', tone: 'coral' },
  cancelado: { label: 'Cancelado', tone: 'neutral' },
}

export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS[status]?.tone ?? 'neutral'}>{STATUS[status]?.label ?? status}</Badge>

export const FLOW_MODES: Record<string, string> = {
  fornecedor: 'Só o fornecedor edita',
  cliente_edita: 'O cliente edita os fluxos existentes',
  cliente_cria: 'O cliente cria fluxos novos',
}

/** 1.250.000 → "1,25 mi" */
export function tokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`
  return String(n)
}

/** Barra de uso com a cor do risco: até 80% neutra, de 80% a 100% atenção, acima disso coral. */
export function UsageBar({ used, limit, label }: { used: number; limit: number; label?: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  const tone = limit > 0 && used >= limit ? 'bg-coral' : pct >= 80 ? 'bg-warn' : 'bg-ink-2/60'
  return (
    <div className="min-w-[120px]">
      <div className="flex justify-between text-[12px] text-muted">
        <span>{label ?? (limit > 0 ? `${pct}%` : 'sem franquia')}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-panel-2">
        <div className={cx('h-1.5 rounded-full', tone)} style={{ width: `${limit > 0 ? Math.max(pct, used > 0 ? 3 : 0) : 0}%` }} />
      </div>
    </div>
  )
}

/** Sugere o endereço a partir do nome: "Marmoraria São José" → "marmoraria-sao-jose". */
export function slugify(name: string) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}
