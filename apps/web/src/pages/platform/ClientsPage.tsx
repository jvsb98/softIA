import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Empty, Input, PageHeader, PixelGlyph, Spinner, Table, Tabs } from '../../components/ui'
import { api } from '../../lib/api'
import { ago } from '../../lib/format'
import { useSession } from '../../lib/session'
import { StatusBadge, tokens, UsageBar, useCatalog } from './shared'

type Filter = 'todos' | 'ativo' | 'implantacao' | 'suspenso' | 'cancelado'

/** O que pede atenção do fornecedor: número fora do ar ou limite perto do fim. */
function attention(c: any): string[] {
  const out: string[] = []
  const down = c.connections.filter((x: any) => x.enabled && x.status !== 'connected')
  if (c.status !== 'cancelado' && down.length) out.push(`${down.length} número(s) fora do ar`)
  if (c.limits.aiTokensMonth > 0 && c.aiTokensMonth >= c.limits.aiTokensMonth * 0.8) out.push(c.aiTokensMonth >= c.limits.aiTokensMonth ? 'franquia de IA esgotada' : 'franquia de IA acima de 80%')
  if (c.activeUsers >= c.limits.maxUsers && c.status !== 'cancelado') out.push('limite de usuários atingido')
  return out
}

export function ClientsPage() {
  const { me } = useSession()
  const navigate = useNavigate()
  const catalog = useCatalog()
  const list = useQuery({ queryKey: ['platform-tenants'], queryFn: () => api.get<any[]>('/api/platform/tenants'), refetchInterval: 30_000 })
  const [filter, setFilter] = useState<Filter>('todos')
  const [search, setSearch] = useState('')
  const canCreate = me?.user.role === 'admin' || me?.user.role === 'implantador'
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (list.data ?? []).filter((c) => (filter === 'todos' ? c.status !== 'cancelado' : c.status === filter) && (!s || `${c.name} ${c.slug}`.toLowerCase().includes(s)))
  }, [list.data, filter, search])
  const count = (st: string) => (list.data ?? []).filter((c) => c.status === st).length
  const needAttention = (list.data ?? []).filter((c) => attention(c).length).length
  const segment = (k: string) => catalog.data?.segments.find((s) => s.key === k)?.label ?? k ?? '—'
  const plan = (k: string) => catalog.data?.plans.find((p) => p.key === k)?.label ?? k ?? '—'

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-8">
      <PageHeader
        title="Clientes"
        description={needAttention ? `${needAttention} cliente(s) pedem atenção: números fora do ar ou limites perto do fim.` : 'Todos os ambientes criados, com a situação de cada um.'}
        actions={
          canCreate && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/clientes/novo')}>
              Novo cliente
            </Button>
          )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-[520px] max-w-full">
          <Tabs
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'todos', label: 'Em uso' },
              { value: 'ativo', label: 'Ativos', count: count('ativo') },
              { value: 'implantacao', label: 'Implantação', count: count('implantacao') },
              { value: 'suspenso', label: 'Suspensos', count: count('suspenso') },
              { value: 'cancelado', label: 'Cancelados' },
            ]}
          />
        </div>
        <div className="relative ml-auto w-[260px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome ou endereço" className="pl-9" />
        </div>
      </div>

      <div className="rounded-[12px] border border-line bg-panel">
        {list.isLoading ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : !rows.length ? (
          <Empty
            glyph={<PixelGlyph pattern="empty" size={40} className="text-muted" />}
            title={list.data?.length ? 'Nenhum cliente neste filtro' : 'Nenhum cliente ainda'}
            action={
              canCreate &&
              !list.data?.length && (
                <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => navigate('/clientes/novo')}>
                  Criar o primeiro cliente
                </Button>
              )
            }
          >
            {list.data?.length ? 'Troque o filtro ou a busca.' : 'Cada cliente ganha um endereço próprio, com a marca dele e os módulos que você liberar.'}
          </Empty>
        ) : (
          <Table head={['Cliente', 'Situação', 'Plano', 'Números', 'Usuários', 'IA no mês', 'Último acesso']}>
            {rows.map((c) => {
              const warn = attention(c)
              const up = c.connections.filter((x: any) => x.status === 'connected').length
              return (
                <tr key={c.id} className="cursor-pointer hover:bg-panel-2/60" onClick={() => navigate(`/clientes/${c.id}`)}>
                  <td className="px-3 py-3">
                    <Link to={`/clientes/${c.id}`} className="font-medium text-ink hover:underline" onClick={(e) => e.stopPropagation()}>
                      {c.name}
                    </Link>
                    <div className="text-[12px] text-muted">
                      {c.hosts} · {segment(c.segment)}
                    </div>
                    {warn.length > 0 && (
                      <div className="mt-1 flex items-center gap-1 text-[12px] text-warn">
                        <AlertTriangle className="size-3.5" /> {warn.join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-3 py-3 text-ink-2">{plan(c.plan)}</td>
                  <td className="px-3 py-3 tabular-nums text-ink-2">
                    {up}/{c.connections.length} no ar <span className="text-muted">· até {c.limits.maxConnections}</span>
                  </td>
                  <td className="px-3 py-3 tabular-nums text-ink-2">
                    {c.activeUsers}/{c.limits.maxUsers}
                  </td>
                  <td className="px-3 py-3">
                    {c.modules.ia?.on ? (
                      <UsageBar used={c.aiTokensMonth} limit={c.limits.aiTokensMonth} label={`${tokens(c.aiTokensMonth)}${c.limits.aiTokensMonth ? ` de ${tokens(c.limits.aiTokensMonth)}` : ''}`} />
                    ) : (
                      <span className="text-[12.5px] text-muted">sem IA</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-[12.5px] text-muted">{c.lastSeen ? ago(c.lastSeen) : 'nunca'}</td>
                </tr>
              )
            })}
          </Table>
        )}
      </div>
    </div>
  )
}
