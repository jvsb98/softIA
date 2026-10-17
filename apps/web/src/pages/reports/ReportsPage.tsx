import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { cx, PageHeader, Select, Spinner, Table } from '@/components/ui'
import { api, qs } from '@/lib/api'
import { LEAD_STATUS } from '@/lib/format'
import { useConnections } from '@/lib/queries'

/*
 * Paleta categórica validada (scripts/validate_palette.js do método de dataviz):
 * claro #2a78d6 · #eb6834 · #1baf7a  |  escuro #3987e5 · #d95926 · #199e70
 * Ordem fixa por entidade: Conversas → Transferidas → Qualificadas.
 */
const SERIES = [
  { key: 'conversations', label: 'Conversas iniciadas', varName: '--viz-1' },
  { key: 'transferred', label: 'Transferidas para humano', varName: '--viz-2' },
  { key: 'qualified', label: 'Leads qualificados', varName: '--viz-3' },
] as const

const fmt = (n: any) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('pt-BR'))
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[12px] border border-line bg-panel p-4">
      <div className="text-[12.5px] text-muted">{label}</div>
      <div className="mt-1 font-display text-[30px] leading-none text-ink">{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-muted">{hint}</div>}
    </div>
  )
}

/** Largura real do contêiner: o SVG desenha em pixels de verdade (texto e traços não escalam). */
function useWidth(el: HTMLElement | null) {
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return w
}

function LineChart({ data }: { data: any[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const W = useWidth(box) || 760
  const H = 240
  const P = { l: 36, r: 12, t: 12, b: 26 }
  const max = Math.max(1, ...data.flatMap((d) => SERIES.map((s) => Number(d[s.key]))))
  const niceMax = Math.ceil(max / 5) * 5 || 5
  const x = (i: number) => P.l + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (W - P.l - P.r))
  const y = (v: number) => P.t + (1 - v / niceMax) * (H - P.t - P.b)
  const ticks = [0, niceMax / 2, niceMax]
  const labelEvery = Math.ceil(data.length / Math.max(3, Math.floor(W / 90)))
  return (
    <div className="viz-root">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-[12.5px] text-ink-2">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-[3px] w-4 rounded" style={{ background: `var(${s.varName})` }} />
            {s.label}
          </span>
        ))}
        <button onClick={() => setAsTable(!asTable)} className="ml-auto text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline">
          {asTable ? 'Ver gráfico' : 'Ver como tabela'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-[260px] overflow-y-auto">
          <Table head={['Dia', ...SERIES.map((s) => s.label)]}>
            {data.map((d) => (
              <tr key={d.day}>
                <td className="px-3 py-1.5 text-ink-2">{d.day.split('-').reverse().slice(0, 2).join('/')}</td>
                {SERIES.map((s) => (
                  <td key={s.key} className="px-3 py-1.5 text-ink">
                    {fmt(d[s.key])}
                  </td>
                ))}
              </tr>
            ))}
          </Table>
        </div>
      ) : (
        <div className="relative" ref={setBox}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" role="img" aria-label="Conversas, transferências e leads qualificados por dia" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
                <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
                  {fmt(t)}
                </text>
              </g>
            ))}
            {data.map((d, i) =>
              i % labelEvery === 0 ? (
                <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">
                  {d.day.slice(8, 10)}/{d.day.slice(5, 7)}
                </text>
              ) : null,
            )}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--line-strong)" />}
            {SERIES.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={`var(${s.varName})`}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={data.map((d, i) => `${x(i)},${y(Number(d[s.key]))}`).join(' ')}
              />
            ))}
            {hover !== null &&
              SERIES.map((s) => <circle key={s.key} cx={x(hover)} cy={y(Number(data[hover]![s.key]))} r="4.5" fill={`var(${s.varName})`} stroke="var(--panel)" strokeWidth="2" />)}
            {data.map((_, i) => (
              <rect
                key={i}
                x={x(i) - (W - P.l - P.r) / Math.max(1, data.length - 1) / 2}
                y={P.t}
                width={(W - P.l - P.r) / Math.max(1, data.length - 1)}
                height={H - P.t - P.b}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-[190px] rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] shadow-panel"
              style={{ left: `${Math.min(70, (x(hover) / W) * 100)}%` }}
            >
              <div className="mb-1 font-medium text-ink">{data[hover]!.day.split('-').reverse().join('/')}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3 text-ink-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full" style={{ background: `var(${s.varName})` }} />
                    {s.label}
                  </span>
                  <span className="font-semibold text-ink">{fmt(data[hover]![s.key])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Bars({ items, total }: { items: { label: string; value: number }[]; total?: number }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <p className="text-[13px] text-muted">Sem dados no período.</p>
  return (
    <ul className="space-y-2.5">
      {items.map((it) => (
        <li key={it.label} title={`${it.label}: ${fmt(it.value)}`}>
          <div className="mb-1 flex justify-between gap-3 text-[12.5px]">
            <span className="truncate text-ink-2">{it.label}</span>
            <span className="shrink-0 font-semibold text-ink">
              {fmt(it.value)}
              {total ? <span className="ml-1 font-normal text-muted">{pct(it.value, total)}</span> : null}
            </span>
          </div>
          <div className="h-2 rounded-[4px] bg-panel-2">
            <div className="h-2 rounded-[4px]" style={{ width: `${(it.value / max) * 100}%`, background: 'var(--viz-1)' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Heatmap({ cells }: { cells: { dow: number; hour: number; n: number }[] }) {
  const max = Math.max(1, ...cells.map((c) => Number(c.n)))
  const get = (d: number, h: number) => Number(cells.find((c) => c.dow === d && c.hour === h)?.n ?? 0)
  const days = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
  return (
    <div className="overflow-x-auto">
      <div className="inline-grid min-w-full gap-[2px]" style={{ gridTemplateColumns: `36px repeat(24, minmax(14px, 1fr))` }}>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[10px] text-muted">
            {h % 3 === 0 ? `${h}h` : ''}
          </span>
        ))}
        {days.map((dn, di) => (
          <div key={dn} className="contents">
            <span className="pr-1 text-right text-[11px] leading-[16px] text-muted">{dn}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const v = get(di + 1, h)
              return (
                <span
                  key={h}
                  title={`${dn} ${h}h: ${v} mensagens`}
                  className="h-4 rounded-[3px]"
                  style={{ background: v ? `color-mix(in oklab, var(--viz-1) ${Math.round(15 + (v / max) * 85)}%, var(--panel))` : 'var(--panel-2)' }}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
        menos
        <span className="h-2 w-24 rounded" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--viz-1) 15%, var(--panel)), var(--viz-1))' }} />
        mais mensagens recebidas
      </div>
    </div>
  )
}

function Card({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-[12px] border border-line bg-panel p-5', className)}>
      <h2 className="text-[14.5px] font-semibold text-ink">{title}</h2>
      {description && <p className="mt-0.5 text-[12.5px] text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function ReportsPage() {
  const [days, setDays] = useState(30)
  const [connectionId, setConnectionId] = useState('')
  const conns = useConnections()
  const r = useQuery({ queryKey: ['reports', days, connectionId], queryFn: () => api.get<any>(`/api/reports/overview${qs({ days, connectionId })}`) })
  const d = r.data
  const funnel = useMemo(() => {
    const order = ['novo', 'em_qualificacao', 'qualificado', 'desqualificado', 'cliente']
    return order.map((k) => ({ label: LEAD_STATUS[k]!, value: Number(d?.funnel?.find((f: any) => f.status === k)?.n ?? 0) }))
  }, [d])
  const t = d?.totals ?? {}
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Relatórios"
          description="Volume, automação, qualificação e tempos de atendimento."
          actions={
            <>
              <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="w-56">
                <option value="">Todas as conexões</option>
                {(conns.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-48">
                <option value="7">Últimos 7 dias</option>
                <option value="30">Últimos 30 dias</option>
                <option value="90">Últimos 90 dias</option>
              </Select>
            </>
          }
        />
        {r.isLoading || !d ? (
          <Spinner />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Tile label="Conversas" value={fmt(t.conversations)} hint={`${fmt(t.open_now)} ainda abertas`} />
              <Tile label="Resolvidas pela automação" value={pct(Number(t.resolved_by_automation), Number(t.conversations))} hint={`${fmt(t.resolved_by_automation)} sem precisar de humano`} />
              <Tile label="Leads qualificados" value={fmt(t.qualified)} hint={`${fmt(t.disqualified)} desqualificados`} />
              <Tile label="Espera média na fila" value={t.avg_wait_min != null ? `${String(t.avg_wait_min).replace('.', ',')} min` : '—'} hint={t.avg_first_response_min != null ? `1ª resposta em ${String(t.avg_first_response_min).replace('.', ',')} min` : undefined} />
            </div>
            <Card title="Evolução diária">
              <LineChart data={d.daily} />
            </Card>
            <div className="grid gap-5 lg:grid-cols-2">
              <Card title="Motivos de transferência" description="Por que as conversas foram para um humano.">
                <Bars items={d.reasons.map((x: any) => ({ label: x.reason, value: Number(x.n) }))} />
              </Card>
              <Card title="Funil de leads" description="Contatos criados no período, por status atual.">
                <Bars items={funnel} total={funnel.reduce((a, b) => a + b.value, 0)} />
              </Card>
            </div>
            <Card title="Setores">
              <Table head={['Setor', 'Conversas no período', 'Na fila agora', 'Em atendimento', 'Espera média', '1ª resposta média']}>
                {d.sectors.map((s: any) => (
                  <tr key={s.id}>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2 font-medium text-ink">
                        <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                        {s.name}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">{fmt(s.conversations)}</td>
                    <td className="px-3 py-2 text-ink-2">{fmt(s.queued_now)}</td>
                    <td className="px-3 py-2 text-ink-2">{fmt(s.open_now)}</td>
                    <td className="px-3 py-2 text-ink-2">{s.avg_wait_min != null ? `${s.avg_wait_min} min` : '—'}</td>
                    <td className="px-3 py-2 text-ink-2">{s.avg_first_response_min != null ? `${s.avg_first_response_min} min` : '—'}</td>
                  </tr>
                ))}
              </Table>
            </Card>
            <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
              <Card title="Atendentes">
                <Table head={['Pessoa', 'Atribuídas', 'Encerradas', 'Mensagens', '1ª resposta média']}>
                  {d.agents.map((a: any) => (
                    <tr key={a.id}>
                      <td className="px-3 py-2 font-medium text-ink">{a.name}</td>
                      <td className="px-3 py-2 text-ink-2">{fmt(a.assigned)}</td>
                      <td className="px-3 py-2 text-ink-2">{fmt(a.closed)}</td>
                      <td className="px-3 py-2 text-ink-2">{fmt(a.messages)}</td>
                      <td className="px-3 py-2 text-ink-2">{a.avg_first_response_min != null ? `${a.avg_first_response_min} min` : '—'}</td>
                    </tr>
                  ))}
                </Table>
              </Card>
              <Card title="Automação e IA">
                <dl className="grid grid-cols-2 gap-4 text-[13px]">
                  {[
                    ['Respostas da IA', fmt(d.ai.ai_replies)],
                    ['Mensagens de fluxo', fmt(d.ai.flow_messages)],
                    ['Mensagens de atendentes', fmt(d.ai.agent_messages)],
                    ['Tempo médio do agente', d.ai.agent_latency_ms ? `${(Number(d.ai.agent_latency_ms) / 1000).toFixed(1).replace('.', ',')} s` : '—'],
                    ['Bloqueios de compliance', fmt(t.compliance_blocked)],
                    ['Follow-ups enviados', fmt(t.followups)],
                    ['Tokens de IA', fmt(d.ai.tokens)],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-muted">{k}</dt>
                      <dd className="mt-0.5 text-[16px] font-semibold text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </div>
            <Card title="Quando os contatos escrevem" description="Mensagens recebidas por dia da semana e hora — útil para dimensionar a equipe e o horário dos setores.">
              <Heatmap cells={d.heat.map((h: any) => ({ dow: Number(h.dow), hour: Number(h.hour), n: Number(h.n) }))} />
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
