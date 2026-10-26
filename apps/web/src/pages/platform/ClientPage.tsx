import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, LogIn, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, Dialog, Field, Input, Section, Select, Spinner, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { ago, dateTime } from '../../lib/format'
import { useSession } from '../../lib/session'
import { LimitsEditor, ModulesEditor } from './NewClientPage'
import { STATUS, StatusBadge, tokens, UsageBar, useCatalog, type Limits } from './shared'

type ModMap = Record<string, { enabled: boolean; config: Record<string, any> }>

const CONN_STATUS: Record<string, string> = { connected: 'no ar', connecting: 'conectando', qr: 'aguardando QR Code', disconnected: 'desconectado', logged_out: 'desconectado do celular' }

/** Rótulos legíveis para a atividade recente do ambiente do cliente. */
const ACTION_LABEL: Record<string, string> = {
  'auth.login': 'entrou',
  'auth.logout': 'saiu',
  'fornecedor.acesso_iniciado': 'acesso do fornecedor iniciado',
  'user.created': 'criou um usuário',
  'connection.created': 'criou uma conexão',
  'flow.published': 'publicou um fluxo',
}

export function ClientPage() {
  const { id } = useParams()
  const { me } = useSession()
  const qc = useQueryClient()
  const catalog = useCatalog()
  const detail = useQuery({ queryKey: ['platform-tenant', id], queryFn: () => api.get<any>(`/api/platform/tenants/${id}`) })
  const role = me?.user.role as string
  const canEdit = role === 'admin' || role === 'implantador'
  const isAdmin = role === 'admin'
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform-tenant', id] })
    qc.invalidateQueries({ queryKey: ['platform-tenants'] })
  }

  const [enterOpen, setEnterOpen] = useState(false)
  const [statusTo, setStatusTo] = useState<string | null>(null)

  if (detail.isLoading || !catalog.data) return <div className="flex justify-center p-16"><Spinner /></div>
  if (detail.error || !detail.data) return <div className="p-10 text-muted">Cliente não encontrado.</div>
  const c = detail.data
  const cat = catalog.data
  const blocked = c.status === 'suspenso' || c.status === 'cancelado'

  return (
    <div className="mx-auto max-w-[1040px] px-10 py-8">
      <Link to="/clientes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Clientes
      </Link>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-[28px] leading-tight text-ink">{c.name}</h1>
            <StatusBadge status={c.status} />
          </div>
          <a href={c.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13.5px] text-muted hover:text-ink">
            {c.url} <ExternalLink className="size-3.5" />
          </a>
          <div className="mt-1 text-[12.5px] text-muted">
            {cat.segments.find((s) => s.key === c.segment)?.label ?? c.segment ?? 'Sem segmento'} · criado em {dateTime(c.created_at)}
            {c.created_by_name ? ` por ${c.created_by_name}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Select value="" onChange={(e) => e.target.value && setStatusTo(e.target.value)} className="w-[190px]" aria-label="Mudar situação">
              <option value="">Mudar situação…</option>
              {Object.entries(STATUS)
                .filter(([k]) => k !== c.status)
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
            </Select>
          )}
          <Button variant="primary" icon={<LogIn className="size-4" />} disabled={blocked} title={blocked ? 'Reative o cliente para entrar no ambiente dele' : undefined} onClick={() => setEnterOpen(true)}>
            Entrar como cliente
          </Button>
        </div>
      </header>

      <div className="space-y-5">
        <Health c={c} />
        <ModulesSection c={c} canEdit={canEdit} onSaved={refresh} />
        <LimitsSection c={c} canEdit={canEdit} onSaved={refresh} />
        <BrandSection c={c} canEdit={canEdit} onSaved={refresh} />
        <DataSection c={c} canEdit={canEdit} onSaved={refresh} />
        <Section title="Atividade recente" description="Últimos registros da auditoria do ambiente do cliente.">
          {!c.recentActivity?.length ? (
            <div className="text-[13px] text-muted">Nada registrado ainda.</div>
          ) : (
            <ul className="divide-y divide-line text-[13px]">
              {c.recentActivity.map((a: any, i: number) => (
                <li key={i} className="flex justify-between gap-4 py-2">
                  <span className="text-ink-2">
                    <span className="font-medium text-ink">{a.user_name ?? 'Sistema'}</span> {ACTION_LABEL[a.action] ?? a.action}
                  </span>
                  <span className="shrink-0 text-muted">{ago(a.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <EnterDialog open={enterOpen} onClose={() => setEnterOpen(false)} tenant={c} reasonRequired={role === 'suporte'} />
      <StatusDialog to={statusTo} tenant={c} onClose={() => setStatusTo(null)} onDone={refresh} />
    </div>
  )
}

function Health({ c }: { c: any }) {
  const h = c.health
  return (
    <Section title="Situação" description="Lida agora do ambiente do cliente.">
      {!h ? (
        <div className="text-[13px] text-muted">Cliente cancelado.</div>
      ) : (
        <>
          {h.error && <div className="mb-3 text-[13px] text-coral-ink">{h.error}</div>}
          <div className="grid gap-5 md:grid-cols-4">
            <Stat label="Números no ar" value={`${h.connections.filter((x: any) => x.status === 'connected').length} de ${h.connections.length}`} sub={`limite ${c.limits.maxConnections}`} />
            <Stat label="Usuários ativos" value={`${h.activeUsers}`} sub={`limite ${c.limits.maxUsers}`} />
            <Stat label="Conversas abertas" value={`${h.openConversations}`} sub={h.lastSeen ? `último acesso ${ago(h.lastSeen)}` : 'ninguém entrou ainda'} />
            <div>
              <div className="text-[12px] text-muted">IA no mês</div>
              {c.modules.ia?.on ? (
                <div className="mt-1.5">
                  <UsageBar used={c.usage.aiTokensMonth} limit={c.limits.aiTokensMonth} label={`${tokens(c.usage.aiTokensMonth)}${c.limits.aiTokensMonth ? ` de ${tokens(c.limits.aiTokensMonth)}` : ''}`} />
                </div>
              ) : (
                <div className="mt-1 text-[14px] text-muted">módulo desligado</div>
              )}
            </div>
          </div>
          {h.connections.length > 0 && (
            <ul className="mt-5 divide-y divide-line border-t border-line text-[13px]">
              {h.connections.map((x: any) => (
                <li key={x.id} className="flex items-center justify-between gap-4 py-2">
                  <span className="text-ink">
                    {x.name} <span className="text-muted">{x.phone ? `· ${x.phone}` : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {x.last_error && x.status !== 'connected' && <span className="max-w-[320px] truncate text-[12px] text-muted" title={x.last_error}>{x.last_error}</span>}
                    <Badge tone={!x.enabled ? 'neutral' : x.status === 'connected' ? 'ok' : 'warn'}>{!x.enabled ? 'desativado' : CONN_STATUS[x.status] ?? x.status}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{value}</div>
      {sub && <div className="text-[12px] text-muted">{sub}</div>}
    </div>
  )
}

function toModMap(view: Record<string, { on: boolean; config: Record<string, any> }>): ModMap {
  return Object.fromEntries(Object.entries(view).map(([k, v]) => [k, { enabled: v.on, config: v.config ?? {} }]))
}

function ModulesSection({ c, canEdit, onSaved }: { c: any; canEdit: boolean; onSaved: () => void }) {
  const catalog = useCatalog()
  const [mods, setMods] = useState<ModMap>(() => toModMap(c.modules))
  const [saving, setSaving] = useState(false)
  const initial = JSON.stringify(toModMap(c.modules))
  useEffect(() => setMods(JSON.parse(initial)), [initial])
  const dirty = JSON.stringify(mods) !== initial
  if (!catalog.data) return null
  const save = async () => {
    setSaving(true)
    try {
      const payload = Object.fromEntries(catalog.data!.modules.filter((m) => !m.base).map((m) => [m.key, mods[m.key] ?? { enabled: false, config: {} }]))
      await api.put(`/api/platform/tenants/${c.id}/modules`, { modules: payload })
      toast.success('Módulos salvos. O cliente vê a mudança no próximo carregamento.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset disabled={!canEdit}>
      <ModulesEditor
        catalog={catalog.data}
        modules={mods}
        onChange={setMods}
        footer={
          canEdit && (
            <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={() => setMods(JSON.parse(initial))} />
          )
        }
      />
    </fieldset>
  )
}

function LimitsSection({ c, canEdit, onSaved }: { c: any; canEdit: boolean; onSaved: () => void }) {
  const initial = JSON.stringify(c.limits)
  const [limits, setLimits] = useState<Limits>(c.limits)
  const [saving, setSaving] = useState(false)
  useEffect(() => setLimits(JSON.parse(initial)), [initial])
  const dirty = JSON.stringify(limits) !== initial
  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/api/platform/tenants/${c.id}/limits`, limits)
      toast.success('Limites salvos.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset disabled={!canEdit}>
      <LimitsEditor
        limits={limits}
        onChange={setLimits}
        aiOn={!!c.modules.ia?.on}
        footer={canEdit && <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={() => setLimits(JSON.parse(initial))} />}
      />
    </fieldset>
  )
}

function BrandSection({ c, canEdit, onSaved }: { c: any; canEdit: boolean; onSaved: () => void }) {
  const [productName, setProductName] = useState(c.brand?.productName ?? '')
  const [color, setColor] = useState(c.brand?.primaryColor ?? '#FE5A51')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirty = productName !== (c.brand?.productName ?? '') || color !== (c.brand?.primaryColor ?? '#FE5A51')
  const save = async () => {
    if (!/^#[0-9a-f]{6}$/i.test(color)) return toast.error('Cor inválida. Use o formato #RRGGBB.')
    setSaving(true)
    try {
      await api.put(`/api/platform/tenants/${c.id}/brand`, { productName: productName.trim(), primaryColor: color })
      toast.success('Marca salva.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }
  const upload = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      await api.upload(`/api/platform/tenants/${c.id}/brand/logo`, form)
      toast.success('Logo atualizado.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }
  const removeLogo = async () => {
    try {
      await api.del(`/api/platform/tenants/${c.id}/brand/logo`)
      toast.success('Logo removido.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  return (
    <Section title="Marca" description="O que o cliente vê no login, no título da aba e nos botões.">
      <div className="grid gap-6 md:grid-cols-[1fr_260px]">
        <div className="space-y-4">
          <Field label="Nome do produto" hint="Em branco, usa o nome da empresa.">
            <Input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder={c.name} maxLength={40} disabled={!canEdit} />
          </Field>
          <Field label="Cor principal">
            <div className="flex items-center gap-3">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={!canEdit} className="h-10 w-14 cursor-pointer rounded-[8px] border border-line-strong bg-panel" aria-label="Cor principal" />
              <Input value={color} onChange={(e) => setColor(e.target.value)} className="max-w-[140px] font-mono" disabled={!canEdit} />
            </div>
          </Field>
          {canEdit && <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={() => (setProductName(c.brand?.productName ?? ''), setColor(c.brand?.primaryColor ?? '#FE5A51'))} />}
        </div>
        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-2">Logo</div>
          <div className="flex h-[96px] items-center justify-center rounded-[10px] border border-dashed border-line-strong bg-bg p-3">
            {c.logoUrl ? <img src={c.logoUrl} alt="Logo do cliente" className="max-h-full max-w-full object-contain" /> : <span className="text-[12.5px] text-muted">Sem logo</span>}
          </div>
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
              <Button size="sm" icon={<Upload className="size-3.5" />} loading={uploading} onClick={() => fileRef.current?.click()}>
                {c.logoUrl ? 'Trocar' : 'Enviar logo'}
              </Button>
              {c.logoUrl && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void removeLogo()}>
                  Remover
                </Button>
              )}
            </div>
          )}
          <div className="mt-1.5 text-[12px] text-muted">PNG, JPG ou WEBP, até 300 KB.</div>
        </div>
      </div>
    </Section>
  )
}

function DataSection({ c, canEdit, onSaved }: { c: any; canEdit: boolean; onSaved: () => void }) {
  const catalog = useCatalog()
  const init = () => ({ name: c.name, segment: c.segment ?? '', plan: c.plan ?? '', contact: { name: c.contact?.name ?? '', phone: c.contact?.phone ?? '', email: c.contact?.email ?? '' }, notes: c.notes ?? '' })
  const [d, setD] = useState(init)
  const [saving, setSaving] = useState(false)
  const initial = JSON.stringify(init())
  useEffect(() => setD(JSON.parse(initial)), [initial])
  const dirty = JSON.stringify(d) !== initial
  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/api/platform/tenants/${c.id}`, { ...d, segment: d.segment || null, plan: d.plan || null, notes: d.notes || null })
      toast.success('Dados salvos.')
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Section title="Dados e cobrança" description="Só a equipe do fornecedor vê. A cobrança é manual: anote aqui valor, dia e forma de pagamento.">
      <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
        <Field label="Nome da empresa">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Segmento">
            <Select value={d.segment} onChange={(e) => setD({ ...d, segment: e.target.value })}>
              <option value="">—</option>
              {catalog.data?.segments.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Plano de referência">
            <Select value={d.plan} onChange={(e) => setD({ ...d, plan: e.target.value })}>
              <option value="">—</option>
              {catalog.data?.plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Contato">
          <Input value={d.contact.name} onChange={(e) => setD({ ...d, contact: { ...d.contact, name: e.target.value } })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Telefone">
            <Input value={d.contact.phone} onChange={(e) => setD({ ...d, contact: { ...d.contact, phone: e.target.value } })} />
          </Field>
          <Field label="E-mail">
            <Input value={d.contact.email} onChange={(e) => setD({ ...d, contact: { ...d.contact, email: e.target.value } })} />
          </Field>
        </div>
        <Field label="Observações internas" className="md:col-span-2">
          <Textarea rows={4} value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Ex.: R$ 297/mês, vence dia 10, Pix." />
        </Field>
      </fieldset>
      {canEdit && (
        <div className="mt-4">
          <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={() => setD(JSON.parse(initial))} />
        </div>
      )}
    </Section>
  )
}

function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div className="flex items-center justify-end gap-2">
      {dirty && <span className="mr-auto text-[12.5px] text-warn">Alterações não salvas</span>}
      <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={onReset}>
        Desfazer
      </Button>
      <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={onSave}>
        Salvar
      </Button>
    </div>
  )
}

function EnterDialog({ open, onClose, tenant, reasonRequired }: { open: boolean; onClose: () => void; tenant: any; reasonRequired: boolean }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      const r = await api.post(`/api/platform/tenants/${tenant.id}/impersonate`, { reason: reason.trim() })
      window.open(r.url, '_blank', 'noopener')
      setReason('')
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Entrar no ambiente de ${tenant.name}`}
      description="Abre em outra aba, com acesso de administrador por até 2 horas. O cliente não perde o próprio acesso, e tudo fica registrado na auditoria dos dois lados."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" icon={<LogIn className="size-4" />} loading={busy} disabled={reasonRequired && reason.trim().length < 5} onClick={() => void go()}>
            Entrar
          </Button>
        </>
      }
    >
      <Field label={reasonRequired ? 'Motivo do acesso (obrigatório)' : 'Motivo do acesso (opcional)'} hint="Aparece na auditoria. Ex.: cliente pediu ajuda para reconectar o número.">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus />
      </Field>
    </Dialog>
  )
}

const STATUS_COPY: Record<string, string> = {
  ativo: 'O cliente volta a ter acesso normal e os números reconectam.',
  implantacao: 'Volta para implantação. O cliente continua com acesso.',
  suspenso: 'O cliente perde o acesso na hora e os números param de atender. Os dados ficam guardados. Use, por exemplo, em caso de falta de pagamento.',
  cancelado: 'Encerra o cliente: sem acesso e sem números. Os dados ficam guardados até a remoção definitiva, que é manual.',
}

function StatusDialog({ to, tenant, onClose, onDone }: { to: string | null; tenant: any; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const danger = to === 'suspenso' || to === 'cancelado'
  const go = async () => {
    setBusy(true)
    try {
      await api.post(`/api/platform/tenants/${tenant.id}/status`, { status: to })
      toast.success(`Situação alterada para ${STATUS[to!]?.label}.`)
      onDone()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={!!to}
      onClose={onClose}
      title={to ? `Mudar ${tenant.name} para "${STATUS[to]?.label}"?` : ''}
      description={to ? STATUS_COPY[to] : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={() => void go()}>
            Confirmar
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-muted">A mudança vale para todos os servidores na hora e fica na auditoria.</div>
    </Dialog>
  )
}
