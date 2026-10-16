import { Handle, Position, type NodeProps } from '@xyflow/react'
import {
  Bot,
  CircleCheck,
  Clock,
  Code,
  Database,
  Flag,
  GitBranch,
  Globe,
  HelpCircle,
  Hourglass,
  List,
  MessageSquare,
  Play,
  ScanText,
  Tag,
  Tags,
  UserPen,
  UserRoundCheck,
  Variable,
  type LucideIcon,
} from 'lucide-react'
import { memo } from 'react'
import { cx } from '@/components/ui'

export const ICONS: Record<string, LucideIcon> = {
  play: Play,
  'message-square': MessageSquare,
  'help-circle': HelpCircle,
  list: List,
  'git-branch': GitBranch,
  variable: Variable,
  clock: Clock,
  hourglass: Hourglass,
  bot: Bot,
  tags: Tags,
  'scan-text': ScanText,
  'user-round-check': UserRoundCheck,
  tag: Tag,
  'user-pen': UserPen,
  'circle-check': CircleCheck,
  flag: Flag,
  globe: Globe,
  code: Code,
  database: Database,
}

/** Cor por categoria — Nimbus para IA (automação), Coral para ações que tiram a conversa do fluxo. */
export const CATEGORY_TONE: Record<string, { bar: string; chip: string }> = {
  Mensagens: { bar: 'bg-ink', chip: 'bg-panel-2 text-ink' },
  Lógica: { bar: 'bg-warn', chip: 'bg-warn/15 text-warn' },
  'Inteligência artificial': { bar: 'bg-nimbus', chip: 'bg-nimbus-soft text-nimbus-ink' },
  Ações: { bar: 'bg-coral', chip: 'bg-coral-soft text-coral-ink' },
  Integrações: { bar: 'bg-ok', chip: 'bg-ok/12 text-ok' },
}

export interface FlowNodeData {
  def: any // tipo (da API)
  config: Record<string, any>
  outputs: { id: string; label: string }[]
  summary: string
  issues: { level: string; message: string }[]
  metrics?: { entered: number; stalled: number; edges: Record<string, number> } | null
  active?: boolean
  visited?: boolean
  [key: string]: unknown
}

export const FlowNodeView = memo(function FlowNodeView({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const Icon = ICONS[d.def?.icon] ?? MessageSquare
  const tone = CATEGORY_TONE[d.def?.category] ?? CATEGORY_TONE.Mensagens!
  const hasError = d.issues.some((i) => i.level === 'error')
  const hasWarn = !hasError && d.issues.some((i) => i.level === 'warning')
  return (
    <div
      className={cx(
        'relative w-[248px] rounded-[12px] border bg-panel shadow-panel transition-shadow',
        selected ? 'border-ink ring-2 ring-ink/15' : 'border-line-strong',
        d.active && 'ring-4 ring-coral/40',
        d.visited && !d.active && 'border-coral/60',
      )}
    >
      {d.def?.type !== 'start' && <Handle type="target" position={Position.Left} className="!size-3 !rounded-[3px] !border-2 !border-panel !bg-ink-2" />}
      <div className={cx('absolute inset-y-0 left-0 w-1 rounded-l-[12px]', tone.bar)} />
      <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
        <span className={cx('flex size-7 shrink-0 items-center justify-center rounded-[7px]', tone.chip)}>
          <Icon className="size-4" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">{(d.config.title as string) || d.def?.label}</div>
          <div className="line-clamp-2 text-[11.5px] leading-snug text-muted">{d.summary || d.def?.description}</div>
        </div>
        {(hasError || hasWarn) && (
          <span className={cx('mt-1 size-2 shrink-0 rounded-[2px]', hasError ? 'bg-coral' : 'bg-warn')} title={d.issues.map((i) => i.message).join('\n')} />
        )}
      </div>
      {d.metrics && (
        <div className="mx-3.5 mb-2 flex gap-2 rounded-[6px] bg-panel-2 px-2 py-1 text-[11px] text-ink-2">
          <span>
            <b>{d.metrics.entered}</b> passaram
          </span>
          {d.metrics.stalled > 0 && (
            <span className="text-coral-ink">
              <b>{d.metrics.stalled}</b> parados aqui
            </span>
          )}
        </div>
      )}
      {d.outputs.length > 0 && (
        <div className="border-t border-line py-1">
          {d.outputs.map((o) => (
            <div key={o.id} className="relative flex items-center justify-end gap-1.5 py-[3px] pl-3 pr-4 text-[11.5px] text-ink-2">
              {d.metrics && <span className="text-[10.5px] text-muted">{d.metrics.edges[o.id] ?? 0}</span>}
              <span className="truncate">{o.label}</span>
              <Handle id={o.id} type="source" position={Position.Right} className="!size-3 !rounded-full !border-2 !border-panel !bg-coral" style={{ top: '50%' }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
})

/** Resumo legível da configuração (aparece no cartão do nó). */
export function summarize(type: string, c: Record<string, any>, lookups: { sectors: any[]; agents: any[] }): string {
  const sector = (id?: string) => lookups.sectors.find((s) => s.id === id)?.name
  switch (type) {
    case 'message':
    case 'question':
    case 'menu':
      return String(c.text ?? '').replace(/\s+/g, ' ').slice(0, 110) + (type === 'question' && c.variable ? ` → {{${c.variable}}}` : '')
    case 'condition':
      return (c.rules ?? []).map((r: any) => `${r.variable} ${r.op} ${r.value ?? ''}`).join(' · ')
    case 'set_variable':
      return `${c.variable ?? '?'} = ${c.value ?? ''}`
    case 'business_hours':
      return sector(c.sectorId) ? `Horário do ${sector(c.sectorId)}` : 'Escolha o setor'
    case 'wait':
      return `${c.minutes ?? 5} minutos`
    case 'ai_agent':
      return `${lookups.agents.find((a) => a.id === c.agentId)?.name ?? 'Agente padrão'}${c.instructions ? ` — ${c.instructions}` : ''}`
    case 'ai_classify':
      return (c.categories ?? []).map((x: any) => x.name).join(', ')
    case 'ai_extract':
      return (c.fields ?? []).map((x: any) => x.name).join(', ')
    case 'transfer':
      return `Para ${sector(c.sectorId) ?? 'setor sugerido/entrada'}${c.reason ? ` — ${c.reason}` : ''}`
    case 'http':
      return `${c.method ?? 'POST'} ${c.url ?? ''}`
    case 'close':
      return c.reason ?? ''
    default:
      return ''
  }
}
