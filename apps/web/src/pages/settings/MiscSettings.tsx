import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Dialog, Field, IconButton, Input, PageHeader, Section, Select, Spinner, Switch, Table, TagChip, Textarea } from '@/components/ui'
import { api } from '@/lib/api'
import { ago, bytes, dateTime } from '@/lib/format'
import { useQuickReplies, useSectors, useTags } from '@/lib/queries'
import { useSession } from '@/lib/session'
import { TwoFactorSetupPage } from '../auth/AuthPages'

// ---------------------------------------------------------------- utilitário de configurações
export function useSettingForm<T extends Record<string, any>>(key: string, defaults: T) {
  const qc = useQueryClient()
  const all = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, any>>('/api/settings') })
  const [value, setValue] = useState<T>(defaults)
  useEffect(() => {
    if (all.data) setValue({ ...defaults, ...(all.data[key] ?? {}) })
  }, [all.data, key]) // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false)
  const save = async (v: T = value) => {
    setSaving(true)
    try {
      await api.put(`/api/settings/${key}`, v)
      await qc.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Configuração salva.')
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }
  return { value, setValue, save, saving, loading: all.isLoading }
}

function NumberField({ label, hint, value, onChange, min, max, suffix }: { label: string; hint?: ReactNode; value: number; onChange: (n: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} className="w-32" />
        {suffix && <span className="text-[13px] text-muted">{suffix}</span>}
      </div>
    </Field>
  )
}

// ---------------------------------------------------------------- perfil
export function ProfileSettings() {
  const { me, refresh } = useSession()
  const [name, setName] = useState(me!.user.name)
  const [signature, setSignature] = useState(me!.user.signature ?? '')
  const [pw, setPw] = useState({ current: '', next: '' })
  const [setup2fa, setSetup2fa] = useState(false)
  const sessions = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get<any[]>('/api/auth/sessions') })
  if (setup2fa) return <TwoFactorSetupPage onDone={() => setSetup2fa(false)} />
  return (
    <div className="space-y-6">
      <PageHeader title="Meu perfil e segurança" />
      <Section title="Perfil" description="A assinatura aparece em negrito no início das suas mensagens (ex.: *Ana — Nimber*).">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Assinatura nas mensagens (opcional)">
            <Input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Ana — Nimber" />
          </Field>
        </div>
        <Button
          variant="primary"
          className="mt-4"
          onClick={async () => {
            await api.patch('/api/auth/profile', { name, signature: signature || null }).then(() => toast.success('Perfil salvo.'), (e) => toast.error(e.message))
            refresh()
          }}
        >
          Salvar perfil
        </Button>
      </Section>
      <Section title="Senha">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Senha atual">
            <Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
          </Field>
          <Field label="Nova senha" hint="Mínimo de 10 caracteres, com letras e números.">
            <Input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
          </Field>
        </div>
        <Button
          className="mt-4"
          disabled={!pw.current || !pw.next}
          onClick={() =>
            api.post('/api/auth/password', pw).then(
              () => {
                toast.success('Senha alterada. As outras sessões foram encerradas.')
                setPw({ current: '', next: '' })
              },
              (e) => toast.error(e.message),
            )
          }
        >
          Alterar senha
        </Button>
      </Section>
      <Section
        title="Verificação em duas etapas"
        description={me!.user.totp_enabled ? 'Ativa. Seu acesso exige o código do app autenticador.' : 'Proteja sua conta com um código do celular a cada login.'}
        actions={me!.user.totp_enabled ? <Badge tone="ok">ativa</Badge> : <Button variant="primary" size="sm" onClick={() => setSetup2fa(true)}>Ativar</Button>}
      >
        <p className="text-[13px] text-muted">Perdeu o celular? Use um dos códigos de recuperação ou peça a um administrador para remover o 2FA.</p>
      </Section>
      <Section
        title="Sessões ativas"
        actions={
          <Button size="sm" onClick={() => api.post('/api/auth/sessions/revoke-others').then(() => sessions.refetch())}>
            Encerrar as outras
          </Button>
        }
      >
        <ul className="divide-y divide-line">
          {(sessions.data ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2 text-[13px]">
              <span className="truncate text-ink-2">{s.user_agent?.slice(0, 70) || 'Navegador'}</span>
              <span className="shrink-0 text-muted">
                {s.ip} · {ago(s.last_seen_at)} {s.current && <Badge tone="ok">esta</Badge>}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- respostas rápidas
export function QuickRepliesSettings() {
  const list = useQuickReplies()
  const sectors = useSectors()
  const { me } = useSession()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<any | null>(null)
  const canEdit = me?.user.role !== 'agent'
  return (
    <div>
      <PageHeader
        title="Respostas rápidas"
        description={
          <>
            Digite <b>/</b> na caixa de mensagem para usar. Variáveis: <code>{'{{nome}}'}</code> (primeiro nome do contato) e <code>{'{{setor}}'}</code>.
          </>
        }
        actions={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ shortcut: '', title: '', body: '', sector_id: null })}>Nova resposta</Button>}
      />
      <div className="rounded-[12px] border border-line bg-panel">
        <Table head={['Atalho', 'Título', 'Texto', 'Setor', '']}>
          {(list.data ?? []).map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2.5 font-medium text-ink">/{r.shortcut}</td>
              <td className="px-3 py-2.5 text-ink-2">{r.title}</td>
              <td className="max-w-sm px-3 py-2.5 text-[12.5px] text-muted">
                <span className="line-clamp-2">{r.body}</span>
              </td>
              <td className="px-3 py-2.5 text-[12.5px] text-ink-2">{r.sector_name ?? 'Todos'}</td>
              <td className="px-3 py-2.5 text-right">{canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>Editar</Button>}</td>
            </tr>
          ))}
        </Table>
      </div>
      {editing && (
        <QuickReplyDialog
          item={editing}
          sectors={sectors.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['quick-replies'] })}
        />
      )}
    </div>
  )
}

function QuickReplyDialog({ item, sectors, onClose, onSaved }: { item: any; sectors: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ shortcut: item.shortcut, title: item.title, body: item.body, sectorId: item.sector_id ?? '' })
  const save = async () => {
    try {
      const body = { ...f, sectorId: f.sectorId || null }
      if (item.id) await api.put(`/api/quick-replies/${item.id}`, body)
      else await api.post('/api/quick-replies', body)
      onSaved()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={item.id ? 'Editar resposta rápida' : 'Nova resposta rápida'}
      footer={
        <>
          {item.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                await api.del(`/api/quick-replies/${item.id}`)
                onSaved()
                onClose()
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={save} disabled={!f.shortcut || !f.title || !f.body}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Atalho" hint="Sem espaços. Ex.: boasvindas">
            <Input value={f.shortcut} onChange={(e) => setF({ ...f, shortcut: e.target.value.replace(/\s/g, '') })} />
          </Field>
          <Field label="Setor">
            <Select value={f.sectorId} onChange={(e) => setF({ ...f, sectorId: e.target.value })}>
              <option value="">Todos os setores</option>
              {sectors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Título">
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Texto">
          <Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} placeholder="Olá, {{nome}}! Que bom falar com você." />
        </Field>
      </div>
    </Dialog>
  )
}

// ---------------------------------------------------------------- etiquetas
export function TagsSettings() {
  const tags = useTags()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [color, setColor] = useState('#99C1E4')
  return (
    <div>
      <PageHeader title="Etiquetas" description="Classifique contatos (origem, interesse, campanha). As etiquetas aparecem na conversa e servem de filtro." />
      <Section title="Nova etiqueta">
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Interesse Hive SP" className="max-w-xs" />
          <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-14 p-1" />
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              await api.post('/api/tags', { name, color })
              setName('')
              qc.invalidateQueries({ queryKey: ['tags'] })
            }}
          >
            Criar
          </Button>
        </div>
      </Section>
      <div className="mt-4 flex flex-wrap gap-2">
        {(tags.data ?? []).map((t) => (
          <span key={t.id} className="inline-flex items-center gap-2 rounded-[8px] border border-line bg-panel py-1 pl-2 pr-1">
            <TagChip name={t.name} color={t.color} />
            <span className="text-[12px] text-muted">{t.uses}</span>
            <IconButton
              label="Excluir etiqueta"
              className="size-6"
              onClick={async () => {
                if (!confirm(`Excluir a etiqueta "${t.name}"?`)) return
                await api.del(`/api/tags/${t.id}`)
                qc.invalidateQueries({ queryKey: ['tags'] })
              }}
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          </span>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- ritmo de envio
export function PacingSettings() {
  const s = useSettingForm('pacing', { typingCharsPerSecond: 18, typingMinMs: 900, typingMaxMs: 6000, minGapMs: 1200, jitterMs: 900, perMinuteLimit: 20 })
  const inbox = useSettingForm('inbox', { debounceMs: 4500, autoCloseHours: 72, reopenWindowHours: 24 })
  if (s.loading) return <Spinner />
  const v = s.value
  return (
    <div className="space-y-6">
      <PageHeader title="Ritmo de envio" description="Como as mensagens automáticas saem: simula uma pessoa digitando para reduzir o risco de bloqueio do número." />
      <Section title="Digitação e intervalos">
        <div className="grid gap-5 md:grid-cols-2">
          <NumberField label="Velocidade de digitação simulada" value={v.typingCharsPerSecond} onChange={(n) => s.setValue({ ...v, typingCharsPerSecond: n })} suffix="caracteres/s" min={5} max={60} />
          <NumberField label="Limite de mensagens por minuto (por número)" value={v.perMinuteLimit} onChange={(n) => s.setValue({ ...v, perMinuteLimit: n })} suffix="mensagens" min={1} max={120} />
          <NumberField label="Tempo mínimo de 'digitando…'" value={v.typingMinMs} onChange={(n) => s.setValue({ ...v, typingMinMs: n })} suffix="ms" />
          <NumberField label="Tempo máximo de 'digitando…'" value={v.typingMaxMs} onChange={(n) => s.setValue({ ...v, typingMaxMs: n })} suffix="ms" />
          <NumberField label="Intervalo mínimo entre mensagens da mesma conversa" value={v.minGapMs} onChange={(n) => s.setValue({ ...v, minGapMs: n })} suffix="ms" />
          <NumberField label="Variação aleatória" value={v.jitterMs} onChange={(n) => s.setValue({ ...v, jitterMs: n })} suffix="ms" />
        </div>
        <Button variant="primary" className="mt-5" loading={s.saving} onClick={() => s.save()}>
          Salvar ritmo
        </Button>
      </Section>
      <Section title="Caixa de entrada">
        <div className="grid gap-5 md:grid-cols-2">
          <NumberField
            label="Agrupar mensagens em sequência"
            hint="A automação espera esse tempo antes de responder, para juntar 'oi' + 'tudo bem?' + 'queria saber…'."
            value={inbox.value.debounceMs}
            onChange={(n) => inbox.setValue({ ...inbox.value, debounceMs: n })}
            suffix="ms"
          />
          <NumberField
            label="Janela de retorno ao mesmo atendente"
            hint="Se o cliente voltar nesse prazo após um atendimento humano, a conversa reabre direto na fila do mesmo setor e atendente."
            value={inbox.value.reopenWindowHours}
            onChange={(n) => inbox.setValue({ ...inbox.value, reopenWindowHours: n })}
            suffix="horas"
          />
        </div>
        <Button variant="primary" className="mt-5" loading={inbox.saving} onClick={() => inbox.save()}>
          Salvar
        </Button>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- segurança
export function SecuritySettings() {
  const s = useSettingForm('security', { require2faAdmins: true, require2faAll: false, sessionHours: 12, passwordMinLength: 10 })
  if (s.loading) return <Spinner />
  const v = s.value
  return (
    <div className="space-y-6">
      <PageHeader title="Política de acesso" />
      <Section title="Autenticação">
        <div className="space-y-4">
          <Switch checked={v.require2faAdmins} onChange={(x) => s.setValue({ ...v, require2faAdmins: x })} label="Exigir 2FA de administradores" />
          <Switch checked={v.require2faAll} onChange={(x) => s.setValue({ ...v, require2faAll: x })} label="Exigir 2FA de todos os usuários" description="Recomendado: a plataforma lida com dados de investidores." />
          <div className="grid gap-5 md:grid-cols-2">
            <NumberField label="Duração da sessão sem uso" value={v.sessionHours} onChange={(n) => s.setValue({ ...v, sessionHours: n })} suffix="horas" min={1} max={720} />
            <NumberField label="Tamanho mínimo de senha" value={v.passwordMinLength} onChange={(n) => s.setValue({ ...v, passwordMinLength: n })} suffix="caracteres" min={8} max={64} />
          </div>
        </div>
        <Button variant="primary" className="mt-5" loading={s.saving} onClick={() => s.save()}>
          Salvar política
        </Button>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- retenção (LGPD)
export function RetentionSettings() {
  const s = useSettingForm('retention', { enabled: false, anonymizeClosedAfterDays: 730, deleteMediaAfterDays: 365 })
  if (s.loading) return <Spinner />
  const v = s.value
  return (
    <div className="space-y-6">
      <PageHeader
        title="Retenção de dados"
        description="LGPD: guarde dados pessoais só pelo tempo necessário. A anonimização remove nome, número, e-mail e o conteúdo das mensagens, mantendo apenas as estatísticas."
      />
      <Section title="Política automática">
        <div className="space-y-4">
          <Switch checked={v.enabled} onChange={(x) => s.setValue({ ...v, enabled: x })} label="Aplicar retenção automaticamente" description="Executa a cada 6 horas." />
          <div className="grid gap-5 md:grid-cols-2">
            <NumberField label="Anonimizar contatos sem conversa ativa há" value={v.anonymizeClosedAfterDays} onChange={(n) => s.setValue({ ...v, anonymizeClosedAfterDays: n })} suffix="dias" min={30} />
            <NumberField label="Apagar arquivos de mídia após" value={v.deleteMediaAfterDays} onChange={(n) => s.setValue({ ...v, deleteMediaAfterDays: n })} suffix="dias" min={7} />
          </div>
        </div>
        <Button variant="primary" className="mt-5" loading={s.saving} onClick={() => s.save()}>
          Salvar política
        </Button>
      </Section>
      <Section title="Direitos do titular">
        <p className="text-[13px] leading-relaxed text-muted">
          Na conversa, o painel lateral tem <b>Exportar dados do titular</b> (direito de acesso). Para eliminar os dados de uma pessoa, um administrador usa a API
          <code className="mx-1">POST /api/contacts/:id/anonymize</code> ou o botão no painel do contato — a ação fica registrada na auditoria.
        </p>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------- auditoria
export function AuditSettings() {
  const [action, setAction] = useState('')
  const log = useQuery({ queryKey: ['audit', action], queryFn: () => api.get<any[]>(`/api/audit?limit=200${action ? `&action=${action}` : ''}`) })
  return (
    <div>
      <PageHeader title="Auditoria" description="Registro de acessos, mudanças de configuração, consultas a dados e bloqueios de compliance." />
      <div className="mb-4 flex gap-2">
        <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-64">
          <option value="">Todas as ações</option>
          <option value="auth.">Acessos</option>
          <option value="user.">Usuários</option>
          <option value="connection.">Conexões</option>
          <option value="settings.">Configurações</option>
          <option value="flow.">Fluxos</option>
          <option value="ai.">IA</option>
          <option value="compliance.">Compliance</option>
          <option value="query.">Consultas a bases externas</option>
          <option value="lgpd.">LGPD</option>
        </Select>
      </div>
      <div className="rounded-[12px] border border-line bg-panel">
        <Table head={['Quando', 'Quem', 'Ação', 'Detalhes', 'IP']}>
          {(log.data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap px-3 py-2 text-[12.5px] text-muted">{dateTime(a.created_at)}</td>
              <td className="px-3 py-2 text-ink-2">{a.user_name ?? 'sistema'}</td>
              <td className="px-3 py-2 font-medium text-ink">{a.action}</td>
              <td className="max-w-md truncate px-3 py-2 text-[12px] text-muted" title={JSON.stringify(a.data)}>
                {Object.keys(a.data ?? {}).length ? JSON.stringify(a.data) : ''}
              </td>
              <td className="px-3 py-2 text-[12px] text-muted">{a.ip}</td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- sistema
export function SystemSettings() {
  const s = useQuery({ queryKey: ['system'], queryFn: () => api.get<any>('/api/system/status'), refetchInterval: 10_000 })
  if (!s.data) return <Spinner />
  const d = s.data
  return (
    <div className="space-y-6">
      <PageHeader title="Saúde do sistema" />
      <div className="grid gap-4 md:grid-cols-4">
        {[
          ['Em execução há', `${Math.floor(d.uptimeSec / 3600)}h ${Math.floor((d.uptimeSec % 3600) / 60)}min`],
          ['Memória', `${d.memoryMb} MB`],
          ['Banco', bytes(d.db.size)],
          ['Node.js', `${d.node} · ${d.platform}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-[12px] border border-line bg-panel p-4">
            <div className="text-[12px] text-muted">{k}</div>
            <div className="mt-1 text-[15px] font-semibold text-ink">{v}</div>
          </div>
        ))}
      </div>
      <Section title="Recursos do PostgreSQL">
        <div className="flex flex-wrap gap-2 text-[13px]">
          <Badge tone={d.capabilities.vector ? 'ok' : 'warn'}>pgvector {d.capabilities.vector ? 'ativo' : 'ausente — busca textual em uso'}</Badge>
          <Badge tone={d.capabilities.unaccent ? 'ok' : 'warn'}>unaccent {d.capabilities.unaccent ? 'ativo' : 'ausente'}</Badge>
          <Badge tone={d.capabilities.trgm ? 'ok' : 'warn'}>pg_trgm {d.capabilities.trgm ? 'ativo' : 'ausente'}</Badge>
        </div>
        <p className="mt-2 text-[12px] text-muted">{d.db.version}</p>
      </Section>
      <Section title="Fila de tarefas (últimas 24h)">
        <Table head={['Fila', 'Status', 'Quantidade']}>
          {d.jobs.map((j: any) => (
            <tr key={j.queue + j.status}>
              <td className="px-3 py-2 text-ink">{j.queue}</td>
              <td className="px-3 py-2">
                <Badge tone={j.status === 'failed' ? 'coral' : j.status === 'done' ? 'ok' : 'warn'}>{j.status}</Badge>
              </td>
              <td className="px-3 py-2 text-ink-2">{j.n}</td>
            </tr>
          ))}
        </Table>
        {d.failed.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[13px] font-medium text-ink">Falhas recentes</div>
            {d.failed.map((f: any) => (
              <details key={f.id} className="rounded-[8px] border border-line px-3 py-2 text-[12.5px]">
                <summary className="cursor-pointer text-ink-2">
                  {f.queue} · {dateTime(f.finished_at)}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[11.5px] text-muted">{f.last_error}</pre>
              </details>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}
