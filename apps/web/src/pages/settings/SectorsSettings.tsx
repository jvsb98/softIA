import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Avatar, Badge, Button, cx, Dialog, Field, IconButton, Input, PageHeader, Select, Spinner, Switch, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { useSectors, useUsers } from '../../lib/queries'

const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const DIST: Record<string, { label: string; help: string }> = {
  round_robin: { label: 'Rodízio', help: 'Distribui uma conversa para cada atendente, em sequência, entre quem está online.' },
  least_busy: { label: 'Menor carga', help: 'Entrega para o atendente online com menos conversas abertas.' },
  pull: { label: 'Puxar da fila', help: 'Ninguém recebe automaticamente: o atendente clica em "Assumir". Com um só atendente, ele recebe direto.' },
}

export function SectorsSettings() {
  const sectors = useSectors()
  const users = useUsers()
  const [editing, setEditing] = useState<any | null>(null)
  return (
    <div>
      <PageHeader
        title="Setores e horários"
        description="Cada setor tem sua equipe, regra de distribuição, horário de atendimento e mensagem automática para fora do horário."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ name: '', color: '#99C1E4', distribution: 'round_robin', hours: {}, hours_enabled: true, active: true, member_ids: [] })}>
            Novo setor
          </Button>
        }
      />
      {sectors.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {sectors.data!.map((s) => (
            <button key={s.id} onClick={() => setEditing(s)} className="flex w-full items-center gap-4 rounded-[12px] border border-line bg-panel p-4 text-left shadow-panel hover:border-line-strong">
              <span className="h-10 w-1.5 rounded-full" style={{ background: s.color }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{s.name}</span>
                  {!s.active && <Badge>inativo</Badge>}
                  <Badge tone="neutral">{DIST[s.distribution]?.label}</Badge>
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted">{s.hours_enabled ? s.hours_label : 'Atende 24h'}</div>
              </div>
              <div className="flex -space-x-1.5">
                {(users.data ?? [])
                  .filter((u) => s.member_ids.includes(u.id))
                  .slice(0, 5)
                  .map((u) => (
                    <Avatar key={u.id} name={u.name} color={u.color} size={28} className="ring-2 ring-panel" />
                  ))}
              </div>
              <div className="w-28 text-right text-[12.5px] text-muted">
                <div>{s.queued} na fila</div>
                <div>{s.open} em atendimento</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && <SectorDialog sector={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function SectorDialog({ sector, onClose }: { sector: any; onClose: () => void }) {
  const users = useUsers()
  const qc = useQueryClient()
  const [f, setF] = useState({
    name: sector.name ?? '',
    description: sector.description ?? '',
    color: sector.color ?? '#99C1E4',
    distribution: sector.distribution ?? 'round_robin',
    hours: (sector.hours ?? {}) as Record<string, [string, string][]>,
    hoursEnabled: sector.hours_enabled ?? true,
    offhoursMessage: sector.offhours_message ?? '',
    active: sector.active ?? true,
    sort: sector.sort ?? 0,
    memberIds: (sector.member_ids ?? []) as string[],
  })
  const [busy, setBusy] = useState(false)

  const setDay = (d: number, ranges: [string, string][]) => setF({ ...f, hours: { ...f.hours, [String(d)]: ranges } })
  const save = async () => {
    setBusy(true)
    try {
      const hours = Object.fromEntries(Object.entries(f.hours).filter(([, r]) => r.length))
      const body = { ...f, hours, description: f.description || null, offhoursMessage: f.offhoursMessage || null }
      if (sector.id) await api.put(`/api/sectors/${sector.id}`, body)
      else await api.post('/api/sectors', body)
      qc.invalidateQueries({ queryKey: ['sectors'] })
      toast.success('Setor salvo.')
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      width={720}
      title={sector.id ? sector.name : 'Novo setor'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.name}>
            Salvar setor
          </Button>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field label="Nome">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field label="Cor">
              <Input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} className="h-10 p-1" />
            </Field>
          </div>
          <Field label="Descrição" hint="Ajuda a IA a decidir para qual setor transferir.">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="Distribuição" hint={DIST[f.distribution]?.help}>
            <Select value={f.distribution} onChange={(e) => setF({ ...f, distribution: e.target.value })}>
              {Object.entries(DIST).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-ink-2">Equipe</div>
            <div className="max-h-44 space-y-1 overflow-y-auto rounded-[8px] border border-line p-2">
              {(users.data ?? [])
                .filter((u) => u.active)
                .map((u) => (
                  <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1 hover:bg-panel-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--coral)]"
                      checked={f.memberIds.includes(u.id)}
                      onChange={(e) => setF({ ...f, memberIds: e.target.checked ? [...f.memberIds, u.id] : f.memberIds.filter((x) => x !== u.id) })}
                    />
                    <Avatar name={u.name} color={u.color} size={22} />
                    <span className="text-[13px] text-ink">{u.name}</span>
                  </label>
                ))}
            </div>
          </div>
          <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Setor ativo" />
        </div>
        <div className="space-y-4">
          <Switch checked={f.hoursEnabled} onChange={(v) => setF({ ...f, hoursEnabled: v })} label="Usar horário de atendimento" description="Desligado, o setor atende 24h." />
          <div className={cx('space-y-1.5', !f.hoursEnabled && 'pointer-events-none opacity-40')}>
            {DAYS.map((name, d) => {
              const ranges = f.hours[String(d)] ?? []
              return (
                <div key={d} className="flex items-start gap-2">
                  <label className="flex w-24 shrink-0 items-center gap-2 pt-1.5 text-[13px] text-ink-2">
                    <input type="checkbox" className="accent-[var(--coral)]" checked={ranges.length > 0} onChange={(e) => setDay(d, e.target.checked ? [['09:00', '18:00']] : [])} />
                    {name.slice(0, 3)}
                  </label>
                  <div className="flex flex-1 flex-col gap-1">
                    {ranges.map(([a, b], i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Input type="time" value={a} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} className="h-8 w-[92px] px-2 text-[13px]" />
                        <span className="text-muted">–</span>
                        <Input type="time" value={b} onChange={(e) => setDay(d, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} className="h-8 w-[92px] px-2 text-[13px]" />
                        <IconButton label="Remover faixa" className="size-7" onClick={() => setDay(d, ranges.filter((_, j) => j !== i))}>
                          <Trash2 className="size-3.5" />
                        </IconButton>
                      </div>
                    ))}
                    {ranges.length > 0 && ranges.length < 3 && (
                      <button className="self-start text-[12px] text-muted hover:text-ink" onClick={() => setDay(d, [...ranges, ['13:00', '18:00']])}>
                        + faixa (ex.: após o almoço)
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <Field label="Mensagem fora do horário" hint="Enviada uma vez quando o cliente escreve fora do horário. Sem IA.">
            <Textarea value={f.offhoursMessage} onChange={(e) => setF({ ...f, offhoursMessage: e.target.value })} rows={4} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}
