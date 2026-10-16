import { useQuery } from '@tanstack/react-query'
import { Bot, Phone, Plus, Search, Smartphone } from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Avatar, cx, Empty, IconButton, PixelGlyph, Select, Tabs } from '@/components/ui'
import { api, qs } from '@/lib/api'
import { contactName, listTime } from '@/lib/format'
import { useSectors } from '@/lib/queries'
import { useSession } from '@/lib/session'

export type View = 'mine' | 'queue' | 'automation' | 'open' | 'closed'

export function ConversationList({ onNew }: { onNew: () => void }) {
  const { me } = useSession()
  const [view, setView] = useState<View>(() => (sessionStorage.getItem('na:view') as View) || 'mine')
  const [search, setSearch] = useState('')
  const [sectorId, setSectorId] = useState('')
  const sectors = useSectors()
  const counts = useQuery({ queryKey: ['counts'], queryFn: () => api.get<any>('/api/conversations/counts'), refetchInterval: 30_000 })
  const list = useQuery({
    queryKey: ['conversations', view, search, sectorId],
    queryFn: () => api.get<any[]>(`/api/conversations${qs({ view, search, sectorId, limit: 80 })}`),
    refetchInterval: 45_000,
  })
  const change = (v: View) => {
    setView(v)
    sessionStorage.setItem('na:view', v)
  }
  const mySectors = useMemo(
    () => (sectors.data ?? []).filter((s) => s.active && (me?.user.role !== 'agent' || me.user.sectorIds.includes(s.id))),
    [sectors.data, me],
  )

  return (
    <div className="flex h-full w-[340px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="space-y-3 border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[22px] text-ink">Atendimento</h1>
          <IconButton label="Nova conversa" onClick={onNew}>
            <Plus className="size-[18px]" />
          </IconButton>
        </div>
        <Tabs
          value={view === 'closed' || view === 'open' ? 'queue' : view}
          onChange={change}
          items={[
            { value: 'mine', label: 'Minhas', count: counts.data?.mine },
            { value: 'queue', label: 'Fila', count: counts.data?.queue },
            { value: 'automation', label: 'Automação', count: counts.data?.automation },
          ]}
        />
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar nome, número ou texto"
              className="h-9 w-full rounded-[8px] border border-line bg-bg pl-8 pr-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-line-strong"
            />
          </div>
          <Select value={sectorId} onChange={(e) => setSectorId(e.target.value)} className="h-9 w-[112px] text-[13px]" aria-label="Filtrar por setor">
            <option value="">Setores</option>
            {mySectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex gap-3 text-[12px]">
          {(
            [
              ['open', 'Todas em atendimento'],
              ['closed', 'Encerradas'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} onClick={() => change(v)} className={cx('hover:text-ink', view === v ? 'font-medium text-ink underline underline-offset-4' : 'text-muted')}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.isLoading ? (
          <ListSkeleton />
        ) : !list.data?.length ? (
          <Empty
            title={view === 'mine' ? 'Nada com você agora' : view === 'queue' ? 'Fila vazia' : view === 'automation' ? 'Nenhuma conversa com a automação' : 'Nada por aqui'}
            glyph={<PixelGlyph pattern={view === 'automation' ? 'ai' : 'chat'} size={40} className="text-line-strong" />}
          >
            {view === 'mine' ? 'Quando uma conversa for atribuída a você, ela aparece aqui.' : view === 'queue' ? 'Conversas aguardando um atendente aparecem aqui.' : null}
          </Empty>
        ) : (
          <ul>
            {list.data.map((c) => (
              <ConversationItem key={c.id} c={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ConversationItem({ c }: { c: any }) {
  const name = contactName(c.contact)
  const waiting = c.status === 'queued' && c.queued_at ? Math.round((Date.now() - new Date(c.queued_at).getTime()) / 60000) : null
  return (
    <li>
      <NavLink
        to={`/atendimento/${c.id}`}
        className={({ isActive }) =>
          cx('relative flex gap-3 border-b border-line px-4 py-3 transition-colors', isActive ? 'bg-panel-2' : 'hover:bg-panel-2/60')
        }
      >
        <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: c.connection?.color }} title={c.connection?.name} />
        <div className="relative">
          <Avatar name={name} color={c.sector?.color} size={40} />
          {c.status === 'automation' && (
            <span className="absolute -bottom-1 -right-1 flex size-[18px] items-center justify-center rounded-[5px] border-2 border-panel bg-nimbus text-navy" title="Em automação">
              <Bot className="size-3" strokeWidth={2.2} />
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cx('truncate text-[14px]', c.unread_count > 0 ? 'font-semibold text-ink' : 'font-medium text-ink')}>{name}</span>
            <span className={cx('shrink-0 text-[11.5px]', c.unread_count > 0 ? 'font-semibold text-coral-ink' : 'text-muted')}>{listTime(c.last_message_at)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="line-clamp-1 flex-1 text-[13px] text-muted">{c.last_message_preview || 'Sem mensagens'}</span>
            {c.unread_count > 0 && <span className="rounded-[5px] bg-coral px-1.5 text-[11px] font-semibold leading-[18px] text-white">{c.unread_count}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {c.priority > 0 && <span className="font-semibold text-coral-ink">{'!'.repeat(c.priority)} prioridade</span>}
            {c.sector && <span className="text-ink-2">{c.sector.name}</span>}
            {c.assignee && <span className="text-muted">· {c.assignee.name.split(' ')[0]}</span>}
            {waiting !== null && waiting >= 1 && <span className={cx(waiting > 15 ? 'text-coral-ink' : 'text-muted')}>· espera {waiting} min</span>}
            {c.contact?.score != null && <span className="rounded-[4px] bg-nimbus-soft px-1 text-nimbus-ink">score {c.contact.score}</span>}
            {c.handoff_reason === 'Respondido pelo celular' && <Smartphone className="size-3 text-muted" />}
            {c.connection?.status && c.connection.status !== 'connected' && <Phone className="size-3 text-coral-ink" />}
          </div>
        </div>
      </NavLink>
    </li>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-px">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="flex gap-3 border-b border-line px-4 py-3">
          <div className="size-10 animate-pulse rounded-[9px] bg-panel-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-panel-2" />
            <div className="h-3 w-full animate-pulse rounded bg-panel-2" />
          </div>
        </div>
      ))}
    </div>
  )
}
