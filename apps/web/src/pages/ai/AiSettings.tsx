import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, ShieldCheck, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Dialog, Field, IconButton, Input, PageHeader, Section, Select, Spinner, Switch, Table, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { useSectors } from '../../lib/queries'
import { useSettingForm } from '../settings/MiscSettings'

const KINDS: Record<string, { label: string; needsKey: boolean; base?: string; models: Record<string, string> }> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    needsKey: true,
    models: { triage: 'claude-haiku-5-5', agent: 'claude-sonnet-5-5', guard: 'claude-haiku-5-5', summary: 'claude-haiku-5-5' },
  },
  openai: {
    label: 'OpenAI',
    needsKey: true,
    models: { triage: 'gpt-5-mini', agent: 'gpt-5', guard: 'gpt-5-mini', summary: 'gpt-5-mini', transcription: 'gpt-4o-transcribe', embedding: 'text-embedding-3-small' },
  },
  gemini: {
    label: 'Google Gemini',
    needsKey: true,
    models: { triage: 'gemini-2.5-flash', agent: 'gemini-2.5-pro', guard: 'gemini-2.5-flash', summary: 'gemini-2.5-flash', transcription: 'gemini-2.5-flash', embedding: 'gemini-embedding-001' },
  },
  openai_compatible: { label: 'Compatível com OpenAI (outro servidor)', needsKey: false, base: 'http://localhost:11434/v1', models: {} },
  mock: { label: 'Simulado (sem custo, para testes)', needsKey: false, models: {} },
}

const TASKS: Record<string, { label: string; help: string }> = {
  triage: { label: 'Triagem', help: 'Classifica cada mensagem: pedido de humano, assunto sensível, frustração. Use um modelo rápido.' },
  agent: { label: 'Agente (conversa)', help: 'Conversa com o lead, tira dúvidas com a base e extrai os critérios. Use o modelo mais capaz.' },
  guard: { label: 'Guarda de compliance', help: 'Revisa cada resposta antes do envio. Rápido e rigoroso.' },
  summary: { label: 'Resumo e sugestões', help: 'Cartão de contexto na transferência e "Sugerir resposta" do atendente.' },
  transcription: { label: 'Transcrição de áudio', help: 'OpenAI ou Gemini. Anthropic não transcreve áudio.' },
  embedding: { label: 'Embeddings (busca semântica)', help: 'Opcional. Exige a extensão pgvector no PostgreSQL. Sem isso, a busca textual é usada.' },
}

// ====================================================================== provedores e modelos
export function AiProvidersSettings() {
  const qc = useQueryClient()
  const providers = useQuery({ queryKey: ['ai-providers'], queryFn: () => api.get<any[]>('/api/ai/providers') })
  const tasks = useQuery({ queryKey: ['ai-tasks'], queryFn: () => api.get<any[]>('/api/ai/tasks') })
  const usage = useQuery({ queryKey: ['ai-usage'], queryFn: () => api.get<any>('/api/ai/usage?days=7') })
  const [editing, setEditing] = useState<any | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ai-providers'] })
    qc.invalidateQueries({ queryKey: ['ai-tasks'] })
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Inteligência artificial"
        description="Cadastre os provedores e escolha o modelo de cada tarefa, com um reserva automático se o principal falhar. As chaves ficam cifradas no banco."
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ kind: 'anthropic', name: 'Anthropic', enabled: true })}>
            Adicionar provedor
          </Button>
        }
      />
      <Section title="Provedores">
        {providers.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Nome', 'Tipo', 'Chave', 'Situação', '']}>
            {providers.data!.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2.5 font-medium text-ink">{p.name}</td>
                <td className="px-3 py-2.5 text-ink-2">{KINDS[p.kind]?.label}</td>
                <td className="px-3 py-2.5 font-mono text-[12px] text-muted">{p.api_key_masked || '—'}</td>
                <td className="px-3 py-2.5">{p.enabled ? <Badge tone="ok">ativo</Badge> : <Badge>inativo</Badge>}</td>
                <td className="px-3 py-2.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                    Editar
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <Section title="Modelo por tarefa" description="Escolha o provedor e o modelo de cada etapa. O reserva entra sozinho se o principal falhar ou demorar.">
        {tasks.isLoading || providers.isLoading ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            {Object.keys(TASKS).map((t) => (
              <TaskRow key={t} task={t} row={tasks.data!.find((r) => r.task === t)} providers={providers.data!} onSaved={refresh} />
            ))}
          </div>
        )}
      </Section>
      <Section title="Uso nos últimos 7 dias">
        {!usage.data?.byTask?.length ? (
          <p className="text-[13px] text-muted">Sem chamadas ainda.</p>
        ) : (
          <Table head={['Tarefa', 'Modelo', 'Chamadas', 'Erros', 'Reserva usado', 'Tokens (entrada/saída)', 'Tempo médio']}>
            {usage.data.byTask.map((u: any, i: number) => (
              <tr key={i}>
                <td className="px-3 py-2 text-ink">{TASKS[u.task]?.label ?? u.task}</td>
                <td className="px-3 py-2 font-mono text-[12px] text-ink-2">{u.model}</td>
                <td className="px-3 py-2 text-ink-2">{u.calls}</td>
                <td className="px-3 py-2">{u.errors > 0 ? <Badge tone="coral">{u.errors}</Badge> : '0'}</td>
                <td className="px-3 py-2 text-ink-2">{u.fallbacks}</td>
                <td className="px-3 py-2 text-ink-2">
                  {Number(u.input_tokens).toLocaleString('pt-BR')} / {Number(u.output_tokens).toLocaleString('pt-BR')}
                </td>
                <td className="px-3 py-2 text-ink-2">{u.avg_ms} ms</td>
              </tr>
            ))}
          </Table>
        )}
        {usage.data?.recentErrors?.length > 0 && (
          <details className="mt-3 text-[12.5px]">
            <summary className="cursor-pointer text-ink-2">Erros recentes</summary>
            <ul className="mt-2 space-y-1 text-muted">
              {usage.data.recentErrors.map((e: any, i: number) => (
                <li key={i}>
                  {TASKS[e.task]?.label}: {e.error}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>
      {editing && <ProviderDialog p={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}

function TaskRow({ task, row, providers, onSaved }: { task: string; row: any; providers: any[]; onSaved: () => void }) {
  const [f, setF] = useState({
    providerId: row?.provider_id ?? '',
    model: row?.model ?? '',
    fallbackProviderId: row?.fallback_provider_id ?? '',
    fallbackModel: row?.fallback_model ?? '',
    temperature: Number(row?.temperature ?? 0.3),
    maxTokens: Number(row?.max_tokens ?? 1024),
  })
  const [dirty, setDirty] = useState(false)
  const set = (patch: any) => {
    setF({ ...f, ...patch })
    setDirty(true)
  }
  const suggest = (pid: string) => KINDS[providers.find((p) => p.id === pid)?.kind]?.models[task] ?? ''
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <span className="text-[14px] font-medium text-ink">{TASKS[task]!.label}</span>
          <span className="ml-2 text-[12px] text-muted">{TASKS[task]!.help}</span>
        </div>
        {dirty && (
          <Button
            size="sm"
            variant="primary"
            onClick={async () => {
              try {
                await api.put(`/api/ai/tasks/${task}`, { ...f, providerId: f.providerId || null, fallbackProviderId: f.fallbackProviderId || null, model: f.model || null, fallbackModel: f.fallbackModel || null })
                setDirty(false)
                toast.success(`${TASKS[task]!.label}: salvo.`)
                onSaved()
              } catch (e: any) {
                toast.error(e.message)
              }
            }}
          >
            Salvar
          </Button>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-4">
        <Select value={f.providerId} onChange={(e) => set({ providerId: e.target.value, model: f.model || suggest(e.target.value) })} aria-label="Provedor principal">
          <option value="">— sem provedor —</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Input value={f.model} onChange={(e) => set({ model: e.target.value })} placeholder={suggest(f.providerId) || 'modelo'} aria-label="Modelo principal" />
        <Select value={f.fallbackProviderId} onChange={(e) => set({ fallbackProviderId: e.target.value, fallbackModel: f.fallbackModel || suggest(e.target.value) })} aria-label="Provedor reserva">
          <option value="">Reserva: nenhum</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              Reserva: {p.name}
            </option>
          ))}
        </Select>
        <Input value={f.fallbackModel} onChange={(e) => set({ fallbackModel: e.target.value })} placeholder="modelo reserva" aria-label="Modelo reserva" />
      </div>
    </div>
  )
}

function ProviderDialog({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: p.name ?? '', kind: p.kind ?? 'anthropic', apiKey: '', baseUrl: p.base_url ?? '', enabled: p.enabled ?? true })
  const [testModel, setTestModel] = useState(KINDS[p.kind ?? 'anthropic']?.models.triage ?? '')
  const [test, setTest] = useState<any>(null)
  const kind = KINDS[f.kind]!
  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={p.id ? `Editar ${p.name}` : 'Adicionar provedor de IA'}
      footer={
        <>
          {p.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm('Excluir este provedor? As tarefas que o usam ficarão sem modelo.')) return
                await api.del(`/api/ai/providers/${p.id}`)
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
                const body = { ...f, apiKey: f.apiKey || undefined, baseUrl: f.baseUrl || null }
                if (p.id) await api.put(`/api/ai/providers/${p.id}`, body)
                else await api.post('/api/ai/providers', body)
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
          <Field label="Tipo">
            <Select
              value={f.kind}
              onChange={(e) => {
                setF({ ...f, kind: e.target.value, name: f.name || KINDS[e.target.value]!.label })
                setTestModel(KINDS[e.target.value]!.models.triage ?? '')
              }}
            >
              {Object.entries(KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
        </div>
        {f.kind !== 'mock' && (
          <Field label="Chave de API" hint={p.id ? `Atual: ${p.api_key_masked || 'nenhuma'}. Deixe em branco para manter.` : 'Fica cifrada (AES-256-GCM) e nunca é exibida de novo.'}>
            <Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
          </Field>
        )}
        {(f.kind === 'openai_compatible' || f.baseUrl) && (
          <Field label="Endereço da API" hint="Para servidores compatíveis com OpenAI (vLLM, Ollama, LM Studio, Azure OpenAI…).">
            <Input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder={kind.base} />
          </Field>
        )}
        <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Ativo" />
        {p.id && (
          <div className="rounded-[10px] border border-line p-3">
            <div className="mb-2 text-[13px] font-medium text-ink">Testar conexão</div>
            <div className="flex gap-2">
              <Input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="modelo" />
              <Button
                icon={<Zap className="size-4" />}
                onClick={async () => {
                  setTest({ busy: true })
                  setTest(await api.post(`/api/ai/providers/${p.id}/test`, { model: testModel }))
                }}
              >
                Testar
              </Button>
            </div>
            {test && !test.busy && (
              <p className={`mt-2 text-[12.5px] ${test.ok ? 'text-ok' : 'text-coral-ink'}`}>{test.ok ? `Respondeu "${test.answer}" em ${test.ms} ms.` : `Falhou: ${test.error}`}</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

// ====================================================================== agente
export function AgentSettings() {
  const qc = useQueryClient()
  const agents = useQuery({ queryKey: ['ai-agents'], queryFn: () => api.get<any[]>('/api/ai/agents') })
  const [sel, setSel] = useState<string | null>(null)
  const agent = agents.data?.find((a) => a.id === sel) ?? agents.data?.[0]
  const [f, setF] = useState<any>(null)
  useEffect(() => {
    if (agent)
      setF({
        name: agent.name,
        persona: agent.persona,
        objective: agent.objective,
        instructions: agent.instructions,
        kbEnabled: agent.kb_enabled,
        qualificationEnabled: agent.qualification_enabled,
        allowedQueryIds: agent.allowed_query_ids ?? [],
        maxTurns: agent.max_turns,
        isDefault: agent.is_default,
        active: agent.active,
      })
  }, [agent?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!agents.data || !f) return <Spinner />
  const save = async () => {
    try {
      await api.put(`/api/ai/agents/${agent.id}`, f)
      toast.success('Agente salvo.')
      qc.invalidateQueries({ queryKey: ['ai-agents'] })
    } catch (e: any) {
      toast.error(e.message)
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Agente de IA"
        description="Personalidade, objetivo e instruções do assistente. O agente padrão atende quando a conexão não tem fluxo; os fluxos podem usar outros agentes."
        actions={
          <div className="flex gap-2">
            {agents.data.length > 1 && (
              <Select value={agent.id} onChange={(e) => setSel(e.target.value)} className="w-56">
                {agents.data.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.is_default ? ' (padrão)' : ''}
                  </option>
                ))}
              </Select>
            )}
            <Button
              icon={<Plus className="size-4" />}
              onClick={async () => {
                const r = await api.post('/api/ai/agents', { ...f, name: `${f.name} (cópia)`, isDefault: false })
                await qc.invalidateQueries({ queryKey: ['ai-agents'] })
                setSel(r.id)
              }}
            >
              Duplicar
            </Button>
          </div>
        }
      />
      <Section title="Identidade">
        <div className="space-y-4">
          <Field label="Nome interno">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Persona e tom de voz">
            <Textarea rows={4} value={f.persona} onChange={(e) => setF({ ...f, persona: e.target.value })} />
          </Field>
          <Field label="Objetivo">
            <Textarea rows={3} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} />
          </Field>
          <Field label="Instruções" hint="Uma regra por linha. As travas de compliance são adicionadas automaticamente e não podem ser removidas aqui.">
            <Textarea rows={9} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
          </Field>
        </div>
      </Section>
      <Section title="Comportamento">
        <div className="grid gap-4 md:grid-cols-2">
          <Switch checked={f.kbEnabled} onChange={(v) => setF({ ...f, kbEnabled: v })} label="Usar a base de conhecimento" />
          <Switch checked={f.qualificationEnabled} onChange={(v) => setF({ ...f, qualificationEnabled: v })} label="Qualificar leads (critérios e score)" />
          <Switch checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} label="Agente padrão" description="Atende conexões sem fluxo de entrada." />
          <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativo" />
          <Field label="Máximo de respostas automáticas por conversa" hint="Ao atingir, transfere para um humano.">
            <Input type="number" min={1} max={100} value={f.maxTurns} onChange={(e) => setF({ ...f, maxTurns: Number(e.target.value) })} className="w-32" />
          </Field>
        </div>
        <Button variant="primary" className="mt-5" onClick={save}>
          Salvar agente
        </Button>
      </Section>
      <AllowedQueries value={f.allowedQueryIds} onChange={(v) => setF({ ...f, allowedQueryIds: v })} onSave={save} />
    </div>
  )
}

function AllowedQueries({ value, onChange, onSave }: { value: string[]; onChange: (v: string[]) => void; onSave: () => void }) {
  const queries = useQuery({ queryKey: ['saved-queries-lite'], queryFn: () => api.get<any[]>('/api/integrations/queries').catch(() => []) })
  const list = (queries.data ?? []).filter((q) => q.ai_enabled && q.enabled)
  return (
    <Section
      title="Consultas a outras bases"
      description="Quais consultas este agente pode usar para responder com dados vivos. Consultas que exigem verificação só rodam depois que o contato confirmar a identidade."
    >
      {!list.length ? (
        <p className="text-[13px] text-muted">Nenhuma consulta disponível. Cadastre em Configurações → Consultas a outras bases.</p>
      ) : (
        <div className="space-y-2">
          {list.map((q) => (
            <label key={q.id} className="flex items-start gap-2.5 rounded-[10px] border border-line p-3 text-[13px]">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--coral)]"
                checked={value.includes(q.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, q.id] : value.filter((x) => x !== q.id))}
              />
              <span className="min-w-0">
                <span className="font-medium text-ink">{q.label}</span>
                {q.is_verification && <span className="ml-2 text-[12px] text-nimbus-ink">verificação de identidade</span>}
                {q.requires_verification && <span className="ml-2 text-[12px] text-warn">exige verificação</span>}
                <span className="block text-[12.5px] text-muted">{q.description}</span>
              </span>
            </label>
          ))}
          <Button variant="primary" className="mt-3" onClick={onSave}>
            Salvar agente
          </Button>
        </div>
      )}
    </Section>
  )
}

// ====================================================================== qualificação
export function QualificationSettings() {
  const qc = useQueryClient()
  const sectors = useSectors()
  const criteria = useQuery({ queryKey: ['ai-criteria'], queryFn: () => api.get<any[]>('/api/ai/criteria') })
  const s = useSettingForm('qualification', { enabled: true, threshold: 22, targetSectorSlug: 'closer', disqualifyBelow: null as number | null })
  const [editing, setEditing] = useState<any | null>(null)
  const [sim, setSim] = useState<Record<string, any>>({})
  const [simResult, setSimResult] = useState<any>(null)
  const maxScore = (criteria.data ?? [])
    .filter((c) => c.active)
    .reduce((acc, c) => {
      const opts = Array.isArray(c.options) ? c.options : Object.values(c.options ?? {}).map((points) => ({ points }))
      return acc + Math.max(0, ...opts.map((o: any) => Number(o.points ?? o) || 0)) * Number(c.weight)
    }, 0)
  useEffect(() => {
    if (!criteria.data) return
    api.post('/api/ai/criteria/simulate', { profile: sim }).then(setSimResult).catch(() => {})
  }, [sim, criteria.data])
  return (
    <div className="space-y-6">
      <PageHeader title="Qualificação de leads" description="A IA extrai as respostas durante a conversa; a pontuação vem destas regras. Ajuste pesos e corte sem mexer em código." />
      <Section title="Regra de qualificação">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Corte (score mínimo para qualificar)" hint={`Pontuação máxima possível hoje: ${Math.round(maxScore)}`}>
            <Input type="number" value={s.value.threshold} onChange={(e) => s.setValue({ ...s.value, threshold: Number(e.target.value) })} />
          </Field>
          <Field label="Setor para leads qualificados">
            <Select value={s.value.targetSectorSlug} onChange={(e) => s.setValue({ ...s.value, targetSectorSlug: e.target.value })}>
              {(sectors.data ?? []).map((x) => (
                <option key={x.id} value={x.slug}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Desqualificar abaixo de (opcional)" hint="Com todos os critérios respondidos.">
            <Input type="number" value={s.value.disqualifyBelow ?? ''} onChange={(e) => s.setValue({ ...s.value, disqualifyBelow: e.target.value === '' ? null : Number(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Switch checked={s.value.enabled} onChange={(v) => s.setValue({ ...s.value, enabled: v })} label="Transferir automaticamente ao qualificar" />
          <Button variant="primary" loading={s.saving} onClick={() => s.save()}>
            Salvar regra
          </Button>
        </div>
      </Section>
      <Section
        title="Critérios"
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ key: '', label: '', question: '', description: '', type: 'choice', options: [], weight: 1, required: true, active: true, sort: (criteria.data?.length ?? 0) + 1 })}>
            Novo critério
          </Button>
        }
      >
        <div className="space-y-2">
          {(criteria.data ?? []).map((c) => (
            <button key={c.id} onClick={() => setEditing(c)} className="flex w-full items-center gap-3 rounded-[10px] border border-line p-3 text-left hover:border-line-strong">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{c.label}</span>
                  <Badge>{c.type === 'choice' ? 'opções' : c.type === 'number' ? 'número' : c.type === 'boolean' ? 'sim/não' : 'texto'}</Badge>
                  {Number(c.weight) !== 1 && <Badge tone="ai">peso {c.weight}</Badge>}
                  {!c.active && <Badge>inativo</Badge>}
                </div>
                <div className="truncate text-[12.5px] text-muted">"{c.question}"</div>
              </div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Simular score" description="Preencha um perfil hipotético para ver a pontuação — útil para calibrar o corte.">
        <div className="grid gap-3 md:grid-cols-3">
          {(criteria.data ?? [])
            .filter((c) => c.active)
            .map((c) => (
              <Field key={c.id} label={c.label}>
                {c.type === 'choice' ? (
                  <Select value={sim[c.key] ?? ''} onChange={(e) => setSim({ ...sim, [c.key]: e.target.value || undefined })}>
                    <option value="">—</option>
                    {c.options.map((o: any) => (
                      <option key={o.value} value={o.value}>
                        {o.label} (+{o.points})
                      </option>
                    ))}
                  </Select>
                ) : c.type === 'boolean' ? (
                  <Select value={sim[c.key] ?? ''} onChange={(e) => setSim({ ...sim, [c.key]: e.target.value === '' ? undefined : e.target.value === 'true' })}>
                    <option value="">—</option>
                    <option value="true">Sim</option>
                    <option value="false">Não</option>
                  </Select>
                ) : (
                  <Input value={sim[c.key] ?? ''} onChange={(e) => setSim({ ...sim, [c.key]: e.target.value || undefined })} />
                )}
              </Field>
            ))}
        </div>
        {simResult && (
          <div className="mt-4 flex items-baseline gap-3">
            <span className="font-display text-[32px] text-ink">{simResult.total}</span>
            <span className="text-[13px] text-muted">pontos</span>
            {simResult.total >= s.value.threshold ? <Badge tone="coral">qualificado → {s.value.targetSectorSlug}</Badge> : <Badge>abaixo do corte ({s.value.threshold})</Badge>}
            {simResult.missing.length > 0 && <span className="text-[12.5px] text-muted">faltam: {simResult.missing.join(', ')}</span>}
          </div>
        )}
      </Section>
      {editing && <CriterionDialog c={editing} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ['ai-criteria'] })} />}
    </div>
  )
}

function CriterionDialog({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    key: c.key,
    label: c.label,
    question: c.question,
    description: c.description ?? '',
    type: c.type,
    options: c.options ?? [],
    weight: Number(c.weight ?? 1),
    required: c.required ?? true,
    disqualifyValues: c.disqualify_values ?? [],
    sort: c.sort ?? 0,
    active: c.active ?? true,
  })
  const opts: any[] = Array.isArray(f.options) ? f.options : []
  const setOpt = (i: number, patch: any) => setF({ ...f, options: opts.map((o, j) => (j === i ? { ...o, ...patch } : o)) })
  return (
    <Dialog
      open
      onClose={onClose}
      width={680}
      title={c.id ? c.label : 'Novo critério'}
      footer={
        <>
          {c.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                if (!confirm('Excluir este critério?')) return
                await api.del(`/api/ai/criteria/${c.id}`)
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
                const body = { ...f, options: f.type === 'boolean' ? (Array.isArray(f.options) ? { true: 5, false: 0 } : f.options) : f.options }
                if (c.id) await api.put(`/api/ai/criteria/${c.id}`, body)
                else await api.post('/api/ai/criteria', body)
                onSaved()
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              }
            }}
          >
            Salvar critério
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Nome">
            <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </Field>
          <Field label="Chave" hint="ex.: tipo_servico">
            <Input value={f.key} onChange={(e) => setF({ ...f, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          </Field>
          <Field label="Tipo">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, options: e.target.value === 'boolean' ? { true: 5, false: 0 } : [] })}>
              <option value="choice">Opções</option>
              <option value="number">Número (faixas)</option>
              <option value="boolean">Sim / não</option>
              <option value="text">Texto livre (sem pontos)</option>
            </Select>
          </Field>
        </div>
        <Field label="Pergunta sugerida para a IA">
          <Input value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />
        </Field>
        <Field label="Orientação de extração" hint="Como a IA deve interpretar a resposta.">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        {f.type === 'choice' && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium text-ink-2">Opções e pontos</div>
            {opts.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.4fr_90px_32px_32px] items-center gap-2">
                <Input value={o.value} onChange={(e) => setOpt(i, { value: e.target.value })} placeholder="valor" className="h-9" />
                <Input value={o.label} onChange={(e) => setOpt(i, { label: e.target.value })} placeholder="rótulo" className="h-9" />
                <Input type="number" value={o.points} onChange={(e) => setOpt(i, { points: Number(e.target.value) })} className="h-9" />
                <input
                  type="checkbox"
                  title="Desqualifica"
                  className="accent-[var(--coral)]"
                  checked={f.disqualifyValues.includes(o.value)}
                  onChange={(e) => setF({ ...f, disqualifyValues: e.target.checked ? [...f.disqualifyValues, o.value] : f.disqualifyValues.filter((v: any) => v !== o.value) })}
                />
                <IconButton label="Remover" className="size-8" onClick={() => setF({ ...f, options: opts.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button size="sm" onClick={() => setF({ ...f, options: [...opts, { value: '', label: '', points: 0 }] })}>
              + opção
            </Button>
            <p className="text-[12px] text-muted">A caixinha marca as opções que desqualificam o lead na hora.</p>
          </div>
        )}
        {f.type === 'number' && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium text-ink-2">Faixas</div>
            {opts.map((o, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_100px_32px] items-center gap-2">
                <Input type="number" value={o.min ?? ''} onChange={(e) => setOpt(i, { min: e.target.value === '' ? null : Number(e.target.value) })} placeholder="de" className="h-9" />
                <Input type="number" value={o.max ?? ''} onChange={(e) => setOpt(i, { max: e.target.value === '' ? null : Number(e.target.value) })} placeholder="até (vazio = sem limite)" className="h-9" />
                <Input type="number" value={o.points} onChange={(e) => setOpt(i, { points: Number(e.target.value) })} className="h-9" />
                <IconButton label="Remover" className="size-8" onClick={() => setF({ ...f, options: opts.filter((_, j) => j !== i) })}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button size="sm" onClick={() => setF({ ...f, options: [...opts, { min: null, max: null, points: 0 }] })}>
              + faixa
            </Button>
          </div>
        )}
        {f.type === 'boolean' && !Array.isArray(f.options) && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pontos se sim">
              <Input type="number" value={(f.options as any).true} onChange={(e) => setF({ ...f, options: { ...(f.options as any), true: Number(e.target.value) } })} />
            </Field>
            <Field label="Pontos se não">
              <Input type="number" value={(f.options as any).false} onChange={(e) => setF({ ...f, options: { ...(f.options as any), false: Number(e.target.value) } })} />
            </Field>
          </div>
        )}
        <div className="grid grid-cols-3 items-end gap-3">
          <Field label="Peso">
            <Input type="number" step="0.5" value={f.weight} onChange={(e) => setF({ ...f, weight: Number(e.target.value) })} />
          </Field>
          <Field label="Ordem">
            <Input type="number" value={f.sort} onChange={(e) => setF({ ...f, sort: Number(e.target.value) })} />
          </Field>
          <div className="space-y-2 pb-2">
            <Switch checked={f.required} onChange={(v) => setF({ ...f, required: v })} label="Obrigatório" />
            <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativo" />
          </div>
        </div>
      </div>
    </Dialog>
  )
}

// ====================================================================== transferência
export function HandoffSettings() {
  const sectors = useSectors()
  const s = useSettingForm('handoff', {
    explicitRequest: true,
    qualified: true,
    noAnswer: true,
    sensitive: true,
    frustration: true,
    failures: true,
    failureLimit: 2,
    existingCustomer: true,
    supportSectorSlug: 'suporte',
    legalSectorSlug: 'juridico',
  })
  if (s.loading) return <Spinner />
  const v = s.value
  const toggle = (k: keyof typeof v, label: string, description: string) => (
    <Switch checked={!!v[k]} onChange={(x) => s.setValue({ ...v, [k]: x })} label={label} description={description} />
  )
  return (
    <div className="space-y-6">
      <PageHeader title="Transferência para humano" description="Quando a IA deve passar a conversa para uma pessoa. Na transferência, o atendente recebe um cartão de contexto gerado pela IA." />
      <Section title="Gatilhos">
        <div className="grid gap-4 md:grid-cols-2">
          {toggle('explicitRequest', 'Pedido explícito', '"Quero falar com uma pessoa".')}
          {toggle('qualified', 'Lead qualificado', 'Score atingiu o corte — vai para o setor de leads qualificados.')}
          {toggle('noAnswer', 'Sem resposta na base', 'A IA não encontrou a resposta no conhecimento.')}
          {toggle('sensitive', 'Assunto sensível', 'Reclamação formal, Procon, advogado, cobrança indevida. Vai para o setor de assuntos sensíveis.')}
          {toggle('frustration', 'Frustração', 'Irritação ou reclamação de demora.')}
          {toggle('existingCustomer', 'Cliente com assunto de pedido ou serviço', 'Andamento, pagamento, pós-venda — vai para o Suporte.')}
          {toggle('failures', 'Falhas de entendimento', 'A IA falhou seguidamente em responder.')}
          <Field label="Falhas seguidas antes de transferir">
            <Input type="number" min={1} max={10} value={v.failureLimit} onChange={(e) => s.setValue({ ...v, failureLimit: Number(e.target.value) })} className="w-24" />
          </Field>
        </div>
      </Section>
      <Section title="Setores de destino">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Suporte (quem já é cliente)">
            <Select value={v.supportSectorSlug} onChange={(e) => s.setValue({ ...v, supportSectorSlug: e.target.value })}>
              {(sectors.data ?? []).map((x) => (
                <option key={x.id} value={x.slug}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assuntos sensíveis / jurídicos" hint="Se o setor estiver inativo, vai para o Suporte.">
            <Select value={v.legalSectorSlug} onChange={(e) => s.setValue({ ...v, legalSectorSlug: e.target.value })}>
              {(sectors.data ?? []).map((x) => (
                <option key={x.id} value={x.slug}>
                  {x.name}
                  {x.active ? '' : ' (inativo)'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button variant="primary" className="mt-5" loading={s.saving} onClick={() => s.save()}>
          Salvar
        </Button>
      </Section>
    </div>
  )
}

// ====================================================================== compliance
export function ComplianceSettings() {
  const s = useSettingForm('compliance', { guardEnabled: false, prefilterEnabled: false, appendDisclaimer: false, disclaimer: '', disclaimerTriggers: [] as string[] })
  const [test, setTest] = useState('')
  const [result, setResult] = useState<any>(null)
  if (s.loading) return <Spinner />
  const v = s.value
  return (
    <div className="space-y-6">
      <PageHeader title="Compliance" description="Travas que a IA não pode ultrapassar. Respostas bloqueadas não são enviadas: a conversa vai para um humano e o bloqueio fica na auditoria." />
      <Section title="Regras sempre ativas" description="Fazem parte das instruções do agente em todos os clientes.">
        <ul className="space-y-2 text-[13.5px] text-ink">
          {['Nunca inventar preços, prazos ou condições fora da base de conhecimento', 'Nunca prometer resultado, garantia ou desconto que não esteja na base', 'Nunca dar diagnóstico nem orientação médica, jurídica ou tributária'].map((t) => (
            <li key={t} className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-ok" /> {t}
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-3">
          <Switch checked={!!v.prefilterEnabled} onChange={(x) => s.setValue({ ...v, prefilterEnabled: x })} label="Pré-filtro do setor financeiro" description="Bloqueia promessa de rentabilidade, recomendação de investimento e orientação tributária. Só para clientes do mercado financeiro." />
          <Switch checked={v.guardEnabled} onChange={(x) => s.setValue({ ...v, guardEnabled: x })} label="Verificador por IA" description="Um segundo modelo revisa cada resposta da IA antes do envio (consome mais da franquia de IA)." />
        </div>
      </Section>
      <Section title="Aviso de risco (disclaimer)" description="Anexado quando a resposta da IA contém uma das palavras abaixo (no máximo uma vez a cada 6 horas por conversa). Ex.: aviso sobre valores aproximados ou sobre orientação profissional.">
        <div className="space-y-4">
          <Switch checked={v.appendDisclaimer} onChange={(x) => s.setValue({ ...v, appendDisclaimer: x })} label="Anexar aviso automaticamente" />
          <Field label="Texto do aviso">
            <Textarea rows={5} value={v.disclaimer} onChange={(e) => s.setValue({ ...v, disclaimer: e.target.value })} />
          </Field>
          <Field label="Palavras que disparam o aviso" hint="Separadas por vírgula.">
            <Input value={(v.disclaimerTriggers ?? []).join(', ')} onChange={(e) => s.setValue({ ...v, disclaimerTriggers: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </Field>
          <Button variant="primary" loading={s.saving} onClick={() => s.save()}>
            Salvar
          </Button>
        </div>
      </Section>
      <Section title="Testar uma resposta" description="Cole uma frase para ver se ela seria bloqueada.">
        <div className="flex gap-2">
          <Input value={test} onChange={(e) => setTest(e.target.value)} placeholder="Ex.: Garantimos entrega em 2 dias com desconto de 30%." />
          <Button onClick={async () => setResult(await api.post('/api/ai/compliance/check', { text: test }))} disabled={!test}>
            Verificar
          </Button>
        </div>
        {result && (
          <p className={`mt-3 text-[13.5px] ${result.ok ? 'text-ok' : 'text-coral-ink'}`}>
            {result.ok ? 'Aprovada.' : `Bloqueada (${result.by === 'filtro' ? 'pré-filtro' : 'verificador IA'}): ${result.label}${result.excerpt ? ` — "${result.excerpt.trim()}"` : ''}`}
          </p>
        )}
      </Section>
    </div>
  )
}
