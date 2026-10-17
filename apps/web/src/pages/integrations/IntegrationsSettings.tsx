import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Database, Plus, Send, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, cx, Dialog, Empty, Field, IconButton, Input, PageHeader, Section, Select, Spinner, Switch, Table, Textarea } from '@/components/ui'
import { api } from '@/lib/api'
import { ago, dateTime } from '@/lib/format'
import { useSettingForm } from '../settings/MiscSettings'

const KIND: Record<string, { label: string; port: number }> = {
  postgres: { label: 'PostgreSQL', port: 5432 },
  mysql: { label: 'MySQL / MariaDB', port: 3306 },
  mssql: { label: 'SQL Server', port: 1433 },
}

// ====================================================================== bases e consultas
export function DataSourcesSettings() {
  const qc = useQueryClient()
  const dbs = useQuery({ queryKey: ['ext-dbs'], queryFn: () => api.get<any[]>('/api/integrations/databases') })
  const queries = useQuery({ queryKey: ['saved-queries'], queryFn: () => api.get<any[]>('/api/integrations/queries') })
  const runs = useQuery({ queryKey: ['query-runs'], queryFn: () => api.get<any[]>('/api/integrations/query-runs') })
  const [editDb, setEditDb] = useState<any | null>(null)
  const [editQ, setEditQ] = useState<any | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ext-dbs'] })
    qc.invalidateQueries({ queryKey: ['saved-queries'] })
    qc.invalidateQueries({ queryKey: ['saved-queries-lite'] })
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Consultas a outras bases"
        description="A IA e os fluxos consultam dados vivos (ofertas abertas, carteira do investidor) por consultas cadastradas aqui. A IA nunca escreve SQL: ela escolhe a consulta e preenche os parâmetros."
      />
      <Section
        title="Bases de dados"
        description="Use um usuário somente leitura. A senha fica cifrada no banco."
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditDb({ kind: 'postgres', port: 5432, ssl: 'false', enabled: true })}>
            Nova base
          </Button>
        }
      >
        {!dbs.data?.length ? (
          <p className="text-[13px] text-muted">Nenhuma base cadastrada.</p>
        ) : (
          <div className="space-y-2">
            {dbs.data.map((d) => (
              <div key={d.id} className="flex items-center gap-3 rounded-[10px] border border-line p-3">
                <Database className="size-5 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ink">{d.name}</div>
                  <div className="text-[12.5px] text-muted">
                    {KIND[d.kind]?.label} · {d.username}@{d.host}:{d.port}/{d.database}
                  </div>
                </div>
                {!d.enabled && <Badge>inativa</Badge>}
                <Button
                  size="sm"
                  onClick={async () => {
                    const r = await api.post(`/api/integrations/databases/${d.id}/test`)
                    r.ok ? toast.success(`${r.message} (${r.ms} ms)`) : toast.error(r.message)
                  }}
                >
                  Testar conexão
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditDb(d)}>
                  Editar
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section
        title="Consultas cadastradas"
        description="Cada consulta vira uma ferramenta que você libera para o agente de IA (Configurações → Agente de IA) e um nó nos fluxos."
        actions={
          dbs.data?.length ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-4" />}
              onClick={() => setEditQ({ database_id: dbs.data![0]!.id, params: [], output_fields: [], masks: {}, max_rows: 20, timeout_ms: 5000, ai_enabled: true, enabled: true })}
            >
              Nova consulta
            </Button>
          ) : undefined
        }
      >
        {!queries.data?.length ? (
          <p className="text-[13px] text-muted">Nenhuma consulta ainda.</p>
        ) : (
          <div className="space-y-2">
            {queries.data.map((q) => (
              <button key={q.id} onClick={() => setEditQ(q)} className="block w-full rounded-[10px] border border-line p-3 text-left hover:border-line-strong">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{q.label}</span>
                  <code className="text-[11.5px] text-muted">{q.name}</code>
                  {q.is_verification && <Badge tone="ai">verificação de identidade</Badge>}
                  {q.requires_verification && <Badge tone="warn">exige verificação</Badge>}
                  {!q.enabled && <Badge>inativa</Badge>}
                  <span className="ml-auto text-[12px] text-muted">{q.runs_7d} execuções em 7 dias</span>
                </div>
                <p className="mt-1 line-clamp-1 text-[12.5px] text-ink-2">{q.description}</p>
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title="Últimas execuções" description="Registro de auditoria: quem consultou, de qual conversa e com quais parâmetros (mascarados).">
        <Table head={['Quando', 'Consulta', 'Origem', 'Parâmetros', 'Linhas', 'Tempo', '']}>
          {(runs.data ?? []).slice(0, 30).map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap px-3 py-1.5 text-[12px] text-muted">{dateTime(r.created_at)}</td>
              <td className="px-3 py-1.5 text-ink-2">{r.query_label ?? '—'}</td>
              <td className="px-3 py-1.5 text-[12.5px] text-ink-2">{r.actor === 'ai' ? 'IA' : r.actor === 'flow' ? 'Fluxo' : r.actor === 'test' ? `Teste (${r.user_name ?? ''})` : r.actor}</td>
              <td className="max-w-[220px] truncate px-3 py-1.5 font-mono text-[11.5px] text-muted">{JSON.stringify(r.params_masked)}</td>
              <td className="px-3 py-1.5 text-ink-2">{r.rows ?? '—'}</td>
              <td className="px-3 py-1.5 text-ink-2">{r.ms} ms</td>
              <td className="px-3 py-1.5">{r.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="coral" className="max-w-[160px] truncate">{r.error}</Badge>}</td>
            </tr>
          ))}
        </Table>
      </Section>
      {editDb && <DbDialog db={editDb} onClose={() => setEditDb(null)} onSaved={refresh} />}
      {editQ && <QueryDialog q={editQ} dbs={dbs.data ?? []} onClose={() => setEditQ(null)} onSaved={refresh} />}
    </div>
  )
}

function DbDialog({ db, onClose, onSaved }: { db: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: db.name ?? '', kind: db.kind, host: db.host ?? '', port: db.port, database: db.database ?? '', username: db.username ?? '', password: '', ssl: db.ssl ?? 'false', enabled: db.enabled ?? true })
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={db.id ? db.name : 'Nova base de dados'}
      footer={
        <>
          {db.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm('Excluir esta base e todas as consultas dela?')) return
                await api.del(`/api/integrations/databases/${db.id}`)
                onSaved()
                onClose()
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const body = { ...f, password: f.password || undefined }
                if (db.id) await api.put(`/api/integrations/databases/${db.id}`, body)
                else await api.post('/api/integrations/databases', body)
                onSaved()
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              }
            }}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nome">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Plataforma de tokenização (leitura)" />
          </Field>
          <Field label="Tipo">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, port: KIND[e.target.value]!.port })}>
              {Object.entries(KIND).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Servidor">
            <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
          </Field>
          <Field label="Porta">
            <Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Banco">
            <Input value={f.database} onChange={(e) => setF({ ...f, database: e.target.value })} />
          </Field>
          <Field label="Usuário (somente leitura)">
            <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />
          </Field>
          <Field label="Senha" hint={db.id ? 'Em branco = manter' : undefined}>
            <Input type="password" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </Field>
        </div>
        <Field label="SSL">
          <Select value={f.ssl} onChange={(e) => setF({ ...f, ssl: e.target.value })}>
            <option value="false">Desligado (rede local)</option>
            <option value="true">Ligado, verificando certificado</option>
            <option value="no-verify">Ligado, sem verificar certificado</option>
          </Select>
        </Field>
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Ativa" />
      </div>
    </Dialog>
  )
}

function QueryDialog({ q, dbs, onClose, onSaved }: { q: any; dbs: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    databaseId: q.database_id,
    name: q.name ?? '',
    label: q.label ?? '',
    description: q.description ?? '',
    sql: q.sql ?? 'SELECT nome, status FROM ofertas WHERE status = :status',
    params: (q.params ?? []) as any[],
    outputFields: (q.output_fields ?? []).join(', '),
    masks: Object.entries(q.masks ?? {}).map(([k, v]) => ({ key: k, value: v as string })),
    maxRows: q.max_rows ?? 20,
    timeoutMs: q.timeout_ms ?? 5000,
    requiresVerification: !!q.requires_verification,
    isVerification: !!q.is_verification,
    aiEnabled: q.ai_enabled ?? true,
    enabled: q.enabled ?? true,
  })
  const [testParams, setTestParams] = useState<Record<string, string>>({})
  const [test, setTest] = useState<any>(null)
  const body = () => ({
    ...f,
    outputFields: f.outputFields.split(',').map((s: string) => s.trim()).filter(Boolean),
    masks: Object.fromEntries(f.masks.filter((m) => m.key).map((m) => [m.key, m.value])),
  })
  const save = async () => {
    try {
      if (q.id) await api.put(`/api/integrations/queries/${q.id}`, body())
      else {
        const r = await api.post('/api/integrations/queries', body())
        q.id = r.id
      }
      onSaved()
      return true
    } catch (e: any) {
      toast.error(e.message)
      return false
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      width={820}
      title={q.id ? q.label : 'Nova consulta'}
      footer={
        <>
          {q.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm('Excluir esta consulta?')) return
                await api.del(`/api/integrations/queries/${q.id}`)
                onSaved()
                onClose()
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={async () => (await save()) && onClose()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Título">
              <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ofertas abertas" />
            </Field>
            <Field label="Identificador" hint="ex.: ofertas_abertas">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
            </Field>
          </div>
          <Field label="Quando usar (lido pela IA)">
            <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Use quando o contato perguntar quais oportunidades estão disponíveis para investir agora." />
          </Field>
          <Field label="Base">
            <Select value={f.databaseId} onChange={(e) => setF({ ...f, databaseId: e.target.value })}>
              {dbs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="SQL (somente SELECT)" hint="Parâmetros com dois-pontos: :cpf, :oferta. Sem ';' e sem comentários.">
            <Textarea rows={7} value={f.sql} onChange={(e) => setF({ ...f, sql: e.target.value })} className="font-mono text-[12.5px]" spellCheck={false} />
          </Field>
          <div className="space-y-2">
            <div className="text-[13px] font-medium text-ink-2">Parâmetros</div>
            {f.params.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px_1.4fr_auto_32px] items-center gap-2">
                <Input value={p.name} onChange={(e) => setF({ ...f, params: f.params.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="nome" className="h-9 font-mono text-[12px]" />
                <Select value={p.type} onChange={(e) => setF({ ...f, params: f.params.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })} className="h-9 text-[12.5px]">
                  {['text', 'number', 'cpf', 'email', 'date'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
                <Input value={p.description ?? ''} onChange={(e) => setF({ ...f, params: f.params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} placeholder="descrição para a IA" className="h-9 text-[12.5px]" />
                <label className="flex items-center gap-1 text-[12px] text-ink-2">
                  <input type="checkbox" className="accent-[var(--coral)]" checked={p.required !== false} onChange={(e) => setF({ ...f, params: f.params.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />
                  obrig.
                </label>
                <IconButton label="Remover" className="size-8" onClick={() => setF({ ...f, params: f.params.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button size="sm" onClick={() => setF({ ...f, params: [...f.params, { name: '', type: 'text', description: '', required: true }] })}>
              + parâmetro
            </Button>
          </div>
        </div>
        <div className="space-y-4">
          <Field label="Campos que podem voltar" hint="Separados por vírgula. Vazio = todos os campos do SELECT.">
            <Input value={f.outputFields} onChange={(e) => setF({ ...f, outputFields: e.target.value })} placeholder="nome, valor_token, captado_pct" />
          </Field>
          <div className="space-y-2">
            <div className="text-[13px] font-medium text-ink-2">Máscaras (LGPD)</div>
            {f.masks.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_130px_32px] gap-2">
                <Input value={m.key} onChange={(e) => setF({ ...f, masks: f.masks.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} placeholder="campo" className="h-9 font-mono text-[12px]" />
                <Select value={m.value} onChange={(e) => setF({ ...f, masks: f.masks.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} className="h-9 text-[12.5px]">
                  <option value="cpf">CPF parcial</option>
                  <option value="email">E-mail parcial</option>
                  <option value="phone">Telefone parcial</option>
                  <option value="partial">3 primeiros caracteres</option>
                  <option value="hide">Ocultar</option>
                </Select>
                <IconButton label="Remover" className="size-8" onClick={() => setF({ ...f, masks: f.masks.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button size="sm" onClick={() => setF({ ...f, masks: [...f.masks, { key: '', value: 'cpf' }] })}>
              + máscara
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Máx. de linhas">
              <Input type="number" value={f.maxRows} onChange={(e) => setF({ ...f, maxRows: Number(e.target.value) })} />
            </Field>
            <Field label="Tempo limite (ms)">
              <Input type="number" value={f.timeoutMs} onChange={(e) => setF({ ...f, timeoutMs: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="space-y-3 rounded-[10px] border border-line p-3">
            <Switch checked={f.isVerification} onChange={(v) => setF({ ...f, isVerification: v })} label="É a consulta de verificação de identidade" description="Retorna uma linha quando os dados (ex.: CPF + e-mail) conferem. Só pode haver uma." />
            <Switch checked={f.requiresVerification} onChange={(v) => setF({ ...f, requiresVerification: v })} label="Exige verificação" description="Só roda depois que o contato confirmar a identidade, e apenas com os próprios dados." />
            <Switch checked={f.aiEnabled} onChange={(v) => setF({ ...f, aiEnabled: v })} label="Disponível para a IA" />
            <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Ativa" />
          </div>
          <div className="rounded-[10px] border border-line p-3">
            <div className="mb-2 text-[13px] font-medium text-ink">Testar</div>
            {f.params.map((p) => (
              <Input key={p.name} className="mb-2 h-9 text-[12.5px]" placeholder={p.name} value={testParams[p.name] ?? ''} onChange={(e) => setTestParams({ ...testParams, [p.name]: e.target.value })} />
            ))}
            <Button
              size="sm"
              onClick={async () => {
                if (!(await save())) return
                setTest(await api.post(`/api/integrations/queries/${q.id}/test`, { params: testParams }))
              }}
            >
              Salvar e executar
            </Button>
            {test && (
              <pre className={cx('mt-2 max-h-48 overflow-auto rounded-[8px] p-2 text-[11.5px]', test.error ? 'bg-coral-soft text-coral-ink' : 'bg-panel-2 text-ink-2')}>
                {test.error ? test.error : JSON.stringify(test.rows, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// ====================================================================== webhooks
export function WebhooksSettings() {
  const qc = useQueryClient()
  const data = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<any>('/api/integrations/webhooks') })
  const [edit, setEdit] = useState<any | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const deliveries = useQuery({ queryKey: ['wh-deliveries', log], queryFn: () => api.get<any[]>(`/api/integrations/webhooks/${log}/deliveries`), enabled: !!log, refetchInterval: 3000 })
  if (!data.data) return <Spinner />
  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description="Avise o n8n, o CRM da intranet ou outro sistema quando um lead for qualificado, uma conversa for transferida ou encerrada. Cada envio é assinado (cabeçalho X-Nimber-Signature: sha256=HMAC do corpo)."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ name: '', url: 'https://n8n.nimber.com.br/webhook/', events: ['lead.qualified'], enabled: true })}>
            Novo webhook
          </Button>
        }
      />
      {!data.data.hooks.length ? (
        <div className="rounded-[12px] border border-line bg-panel">
          <Empty title="Nenhum webhook">Exemplo: enviar todo lead qualificado para um workflow do n8n que cria o card no pipeline do Closer.</Empty>
        </div>
      ) : (
        <div className="space-y-3">
          {data.data.hooks.map((h: any) => (
            <div key={h.id} className="rounded-[12px] border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{h.name}</span>
                {!h.enabled && <Badge>inativo</Badge>}
                {h.failed_7d > 0 && <Badge tone="coral">{h.failed_7d} falhas em 7 dias</Badge>}
                <span className="ml-auto text-[12px] text-muted">{h.last_delivered_at ? `última entrega ${ago(h.last_delivered_at)}` : 'nunca entregue'}</span>
              </div>
              <div className="mt-1 truncate font-mono text-[12px] text-muted">{h.url}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {h.events.map((e: string) => (
                  <Badge key={e} tone="ai">
                    {e}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => api.post(`/api/integrations/webhooks/${h.id}/test`).then(() => (toast.success('Teste enviado.'), setLog(h.id)))}>
                  Enviar teste
                </Button>
                <Button size="sm" onClick={() => setLog(log === h.id ? null : h.id)}>
                  Entregas
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(h)}>
                  Editar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => api.post(`/api/integrations/webhooks/${h.id}/rotate-secret`).then((r) => setSecret(r.secret))}>
                  Gerar novo segredo
                </Button>
              </div>
              {log === h.id && (
                <div className="mt-3">
                  <Table head={['Quando', 'Evento', 'Situação', 'HTTP', 'Tentativas', 'Erro']}>
                    {(deliveries.data ?? []).map((d) => (
                      <tr key={d.id}>
                        <td className="px-3 py-1.5 text-[12px] text-muted">{dateTime(d.created_at)}</td>
                        <td className="px-3 py-1.5 text-ink-2">{d.event}</td>
                        <td className="px-3 py-1.5">
                          <Badge tone={d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'coral' : 'warn'}>{d.status === 'delivered' ? 'entregue' : d.status === 'failed' ? 'falhou' : 'pendente'}</Badge>
                        </td>
                        <td className="px-3 py-1.5 text-ink-2">{d.response_code ?? '—'}</td>
                        <td className="px-3 py-1.5 text-ink-2">{d.attempts}</td>
                        <td className="max-w-[220px] truncate px-3 py-1.5 text-[12px] text-muted">{d.error}</td>
                      </tr>
                    ))}
                  </Table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {edit && (
        <WebhookDialog
          hook={edit}
          events={data.data.events}
          onClose={() => setEdit(null)}
          onSaved={(s) => {
            qc.invalidateQueries({ queryKey: ['webhooks'] })
            if (s) setSecret(s)
          }}
        />
      )}
      <Dialog open={!!secret} onClose={() => setSecret(null)} title="Segredo do webhook" description="Use para validar a assinatura no n8n/CRM. Ele não será exibido de novo.">
        <div className="flex gap-2">
          <code className="flex-1 break-all rounded-[8px] bg-panel-2 px-3 py-2 text-[13px] text-ink">{secret}</code>
          <IconButton label="Copiar" onClick={() => navigator.clipboard?.writeText(secret ?? '')}>
            <Copy className="size-4" />
          </IconButton>
        </div>
      </Dialog>
    </div>
  )
}

function WebhookDialog({ hook, events, onClose, onSaved }: { hook: any; events: Record<string, string>; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [f, setF] = useState({ name: hook.name, url: hook.url, events: hook.events as string[], enabled: hook.enabled })
  return (
    <Dialog
      open
      onClose={onClose}
      width={600}
      title={hook.id ? hook.name : 'Novo webhook'}
      footer={
        <>
          {hook.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                await api.del(`/api/integrations/webhooks/${hook.id}`)
                onSaved()
                onClose()
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={!f.name || !f.url || !f.events.length}
            onClick={async () => {
              try {
                if (hook.id) {
                  await api.put(`/api/integrations/webhooks/${hook.id}`, f)
                  onSaved()
                } else {
                  const r = await api.post('/api/integrations/webhooks', f)
                  onSaved(r.secret)
                }
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              }
            }}
          >
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="n8n — leads qualificados para o CRM" />
        </Field>
        <Field label="URL">
          <Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        </Field>
        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-2">Eventos</div>
          <div className="space-y-1.5">
            {Object.entries(events).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  className="accent-[var(--coral)]"
                  checked={f.events.includes(k) || f.events.includes('*')}
                  onChange={(e) => setF({ ...f, events: e.target.checked ? [...f.events.filter((x) => x !== '*'), k] : f.events.filter((x) => x !== k && x !== '*') })}
                />
                <code className="text-[12px] text-muted">{k}</code> {label}
              </label>
            ))}
          </div>
        </div>
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Ativo" />
      </div>
    </Dialog>
  )
}

// ====================================================================== follow-ups
export function FollowupsSettings() {
  const s = useSettingForm('followups', {
    enabled: true,
    onlyBusinessHours: true,
    hoursSectorSlug: 'sdr',
    applyTo: 'automation',
    attempts: [] as { afterHours: number; message: string; useAi?: boolean }[],
    autoCloseAfterHours: 48,
    optOutKeywords: [] as string[],
  })
  const sectors = useQuery({ queryKey: ['sectors'], queryFn: () => api.get<any[]>('/api/sectors') })
  if (s.loading) return <Spinner />
  const v = s.value
  const setAttempt = (i: number, patch: any) => s.setValue({ ...v, attempts: v.attempts.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  return (
    <div className="space-y-6">
      <PageHeader title="Follow-ups automáticos" description="Retoma conversas paradas — só com quem já falou com a Nimber. Para na hora se o contato responder ou pedir para parar." />
      <Section title="Regras">
        <div className="space-y-4">
          <Switch checked={v.enabled} onChange={(x) => s.setValue({ ...v, enabled: x })} label="Enviar follow-ups" />
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Aplicar em">
              <Select value={v.applyTo} onChange={(e) => s.setValue({ ...v, applyTo: e.target.value })}>
                <option value="automation">Só conversas com a IA ou fluxo</option>
                <option value="all">Todas as conversas abertas</option>
              </Select>
            </Field>
            <Field label="Respeitar o horário do setor">
              <Select value={v.hoursSectorSlug} onChange={(e) => s.setValue({ ...v, hoursSectorSlug: e.target.value })}>
                {(sectors.data ?? []).map((x) => (
                  <option key={x.id} value={x.slug}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Encerrar sem resposta após (horas)" hint="Conta a partir da última tentativa. 0 = não encerrar.">
              <Input type="number" value={v.autoCloseAfterHours} onChange={(e) => s.setValue({ ...v, autoCloseAfterHours: Number(e.target.value) })} />
            </Field>
          </div>
          <Switch checked={v.onlyBusinessHours} onChange={(x) => s.setValue({ ...v, onlyBusinessHours: x })} label="Enviar só dentro do horário" />
        </div>
      </Section>
      <Section title="Tentativas" description="Use {{nome}} para o primeiro nome. Máximo recomendado: 2 tentativas.">
        <div className="space-y-3">
          {v.attempts.map((a, i) => (
            <div key={i} className="rounded-[10px] border border-line p-3">
              <div className="mb-2 flex items-center gap-3">
                <span className="text-[13px] font-medium text-ink">Tentativa {i + 1}</span>
                <span className="text-[12.5px] text-muted">após</span>
                <Input type="number" value={a.afterHours} onChange={(e) => setAttempt(i, { afterHours: Number(e.target.value) })} className="h-8 w-20" />
                <span className="text-[12.5px] text-muted">horas sem resposta</span>
                <IconButton label="Remover tentativa" className="ml-auto size-8" onClick={() => s.setValue({ ...v, attempts: v.attempts.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
              <Textarea rows={2} value={a.message} onChange={(e) => setAttempt(i, { message: e.target.value })} />
              <div className="mt-2">
                <Switch checked={!!a.useAi} onChange={(x) => setAttempt(i, { useAi: x })} label="Personalizar com IA" description="A IA reescreve retomando o último assunto (passa pela guarda de compliance; se bloquear, usa o texto acima)." />
              </div>
            </div>
          ))}
          {v.attempts.length < 4 && (
            <Button size="sm" onClick={() => s.setValue({ ...v, attempts: [...v.attempts, { afterHours: 24 * (v.attempts.length + 1), message: 'Oi, {{nome}}! Posso te ajudar com mais alguma coisa?', useAi: false }] })}>
              + tentativa
            </Button>
          )}
        </div>
      </Section>
      <Section title="Pedidos para parar (opt-out)">
        <Field label="Palavras que marcam o contato como 'não quer receber mensagens'" hint="Separadas por vírgula. Vale para mensagens que contenham só a palavra.">
          <Input value={(v.optOutKeywords ?? []).join(', ')} onChange={(e) => s.setValue({ ...v, optOutKeywords: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </Field>
        <Button variant="primary" className="mt-5" loading={s.saving} onClick={() => s.save()}>
          Salvar follow-ups
        </Button>
      </Section>
    </div>
  )
}

// ====================================================================== alertas e feriados
export function AlertsSettings() {
  const s = useSettingForm('notifications', { slackWebhookUrl: '', notifyConnectionDown: true, notifyComplianceBlock: true })
  if (s.loading) return <Spinner />
  const v = s.value
  return (
    <div className="space-y-6">
      <PageHeader title="Alertas da equipe" description="Avisos no Slack quando algo precisa de atenção (no máximo um alerta igual a cada 30 minutos)." />
      <Section title="Slack">
        <div className="space-y-4">
          <Field label="URL do Incoming Webhook do Slack" hint="Crie em api.slack.com → Incoming Webhooks, apontando para o canal da tecnologia.">
            <Input value={v.slackWebhookUrl} onChange={(e) => s.setValue({ ...v, slackWebhookUrl: e.target.value })} placeholder="https://hooks.slack.com/services/…" />
          </Field>
          <Switch checked={v.notifyConnectionDown} onChange={(x) => s.setValue({ ...v, notifyConnectionDown: x })} label="Conexão de WhatsApp desconectada ou com erro" />
          <Switch checked={v.notifyComplianceBlock} onChange={(x) => s.setValue({ ...v, notifyComplianceBlock: x })} label="Resposta da IA bloqueada pelo compliance" />
          <Button variant="primary" loading={s.saving} onClick={() => s.save()}>
            Salvar
          </Button>
        </div>
      </Section>
    </div>
  )
}

export function HolidaysSettings() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['holidays'], queryFn: () => api.get<any[]>('/api/holidays') })
  const [day, setDay] = useState('')
  const [name, setName] = useState('')
  return (
    <div className="space-y-6">
      <PageHeader title="Feriados" description="Nos feriados, todos os setores ficam fora do horário (mensagem fixa e fila para o próximo dia útil)." />
      <Section title="Adicionar feriado" description="Os feriados nacionais fixos já vêm cadastrados. Inclua os móveis (Carnaval, Sexta-feira Santa, Corpus Christi) e os de Curitiba.">
        <div className="flex flex-wrap gap-2">
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" className="w-64" />
          <Button
            variant="primary"
            disabled={!day || !name}
            onClick={async () => {
              await api.post('/api/holidays', { day, name })
              setDay('')
              setName('')
              qc.invalidateQueries({ queryKey: ['holidays'] })
            }}
          >
            Adicionar
          </Button>
        </div>
      </Section>
      <div className="rounded-[12px] border border-line bg-panel">
        <Table head={['Data', 'Feriado', '']}>
          {(list.data ?? []).map((h) => (
            <tr key={h.id}>
              <td className="px-3 py-2 text-ink-2">{h.day.split('-').reverse().join('/')}</td>
              <td className="px-3 py-2 text-ink">{h.name}</td>
              <td className="px-3 py-2 text-right">
                <IconButton label="Remover" onClick={() => api.del(`/api/holidays/${h.id}`).then(() => qc.invalidateQueries({ queryKey: ['holidays'] }))}>
                  <Trash2 className="size-4" />
                </IconButton>
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </div>
  )
}
