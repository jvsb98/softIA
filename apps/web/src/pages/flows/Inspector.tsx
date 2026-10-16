import { Plus, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button, cx, Field, IconButton, Input, Select, Switch, Textarea } from '@/components/ui'
import { useSectors, useTags, useUsers } from '@/lib/queries'
import { ICONS, CATEGORY_TONE } from './FlowNode'

const OPS = [
  { value: 'equals', label: 'é igual a' },
  { value: 'not_equals', label: 'é diferente de' },
  { value: 'contains', label: 'contém' },
  { value: 'not_contains', label: 'não contém' },
  { value: 'gt', label: 'maior que' },
  { value: 'gte', label: 'maior ou igual a' },
  { value: 'lt', label: 'menor que' },
  { value: 'lte', label: 'menor ou igual a' },
  { value: 'exists', label: 'está preenchida' },
  { value: 'not_exists', label: 'está vazia' },
  { value: 'is_true', label: 'é verdadeira' },
  { value: 'is_false', label: 'é falsa' },
  { value: 'regex', label: 'casa com expressão' },
]

function ListEditor<T extends Record<string, any>>({
  items,
  onChange,
  blank,
  render,
  addLabel,
}: {
  items: T[]
  onChange: (items: T[]) => void
  blank: T
  render: (item: T, set: (patch: Partial<T>) => void, index: number) => ReactNode
  addLabel: string
}) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="relative rounded-[8px] border border-line p-2 pr-9">
          {render(it, (patch) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x))), i)}
          <IconButton label="Remover" className="absolute right-1 top-1 size-7" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...items, { ...blank }])}>
        {addLabel}
      </Button>
    </div>
  )
}

function FieldInput({ spec, value, onChange, agents, queries }: { spec: any; value: any; onChange: (v: any) => void; agents: any[]; queries: any[] }) {
  const sectors = useSectors()
  const users = useUsers()
  const tags = useTags()
  const v = value ?? spec.default ?? ''
  switch (spec.type) {
    case 'textarea':
      return <Textarea rows={4} value={v} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />
    case 'code':
      return <Textarea rows={8} value={v} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} className="font-mono text-[12.5px]" spellCheck={false} />
    case 'number':
      return <Input type="number" value={v} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    case 'boolean':
      return <Switch checked={!!value} onChange={onChange} />
    case 'select':
      return (
        <Select value={String(v)} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o: any) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )
    case 'sector':
      return (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(sectors.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? '' : ' (inativo)'}
            </option>
          ))}
        </Select>
      )
    case 'user':
      return (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">Distribuição automática</option>
          {(users.data ?? [])
            .filter((u) => u.active)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
        </Select>
      )
    case 'agent':
      return (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">Agente padrão</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
      )
    case 'query':
      return (
        <Select value={v} onChange={(e) => onChange(e.target.value)}>
          <option value="">Escolha a consulta…</option>
          {queries.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
      )
    case 'tags': {
      const sel: string[] = Array.isArray(value) ? value : []
      return (
        <div className="flex flex-wrap gap-1.5">
          {(tags.data ?? []).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(sel.includes(t.id) ? sel.filter((x) => x !== t.id) : [...sel, t.id])}
              className={cx('rounded-[6px] border px-2 py-0.5 text-[12px]', sel.includes(t.id) ? 'border-ink bg-ink text-bg' : 'border-line-strong text-ink-2')}
            >
              {t.name}
            </button>
          ))}
          {!tags.data?.length && <span className="text-[12px] text-muted">Crie etiquetas em Configurações → Etiquetas.</span>}
        </div>
      )
    }
    case 'options':
      return (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          blank={{ label: '', keywords: '' }}
          addLabel="Adicionar opção"
          render={(it, set, i) => (
            <div className="space-y-1.5">
              <Input value={it.label} onChange={(e) => set({ label: e.target.value })} placeholder={`Opção ${i + 1}`} className="h-8 text-[13px]" />
              <Input value={it.keywords ?? ''} onChange={(e) => set({ keywords: e.target.value })} placeholder="palavras-chave, separadas por vírgula" className="h-8 text-[12px]" />
            </div>
          )}
        />
      )
    case 'rules':
      return (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          blank={{ label: '', variable: '', op: 'equals', value: '' }}
          addLabel="Adicionar regra"
          render={(it, set, i) => (
            <div className="space-y-1.5">
              <Input value={it.label ?? ''} onChange={(e) => set({ label: e.target.value })} placeholder={`Nome do caminho (Regra ${i + 1})`} className="h-8 text-[13px]" />
              <Input value={it.variable} onChange={(e) => set({ variable: e.target.value })} placeholder="variável — ex.: contato.score" className="h-8 font-mono text-[12px]" />
              <div className="grid grid-cols-2 gap-1.5">
                <Select value={it.op} onChange={(e) => set({ op: e.target.value })} className="h-8 text-[12.5px]">
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {!['exists', 'not_exists', 'is_true', 'is_false'].includes(it.op) && (
                  <Input value={it.value ?? ''} onChange={(e) => set({ value: e.target.value })} placeholder="valor" className="h-8 text-[12.5px]" />
                )}
              </div>
            </div>
          )}
        />
      )
    case 'categories':
      return (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          blank={{ name: '', description: '' }}
          addLabel="Adicionar categoria"
          render={(it, set) => (
            <div className="space-y-1.5">
              <Input value={it.name} onChange={(e) => set({ name: e.target.value })} placeholder="nome (ex.: resgate)" className="h-8 text-[13px]" />
              <Input value={it.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="quando escolher esta categoria" className="h-8 text-[12px]" />
            </div>
          )}
        />
      )
    case 'fields':
      return (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          blank={{ name: '', description: '' }}
          addLabel="Adicionar campo"
          render={(it, set) => (
            <div className="space-y-1.5">
              <Input value={it.name} onChange={(e) => set({ name: e.target.value.replace(/[^\w]/g, '_') })} placeholder="variável (ex.: cidade)" className="h-8 font-mono text-[12px]" />
              <Input value={it.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder="o que extrair" className="h-8 text-[12px]" />
            </div>
          )}
        />
      )
    case 'keyvalue':
      return (
        <ListEditor
          items={Array.isArray(value) ? value : []}
          onChange={onChange}
          blank={{ key: '', value: '' }}
          addLabel="Adicionar"
          render={(it, set) => (
            <div className="grid grid-cols-2 gap-1.5">
              <Input value={it.key} onChange={(e) => set({ key: e.target.value })} placeholder="chave" className="h-8 font-mono text-[12px]" />
              <Input value={it.value ?? ''} onChange={(e) => set({ value: e.target.value })} placeholder="valor" className="h-8 text-[12px]" />
            </div>
          )}
        />
      )
    default:
      return <Input value={v} onChange={(e) => onChange(e.target.value)} placeholder={spec.placeholder} />
  }
}

export function Inspector({
  node,
  def,
  issues,
  onChange,
  onDelete,
  onClose,
  agents,
  queries,
  readOnly,
}: {
  node: any
  def: any
  issues: { level: string; message: string }[]
  onChange: (data: Record<string, any>) => void
  onDelete: () => void
  onClose: () => void
  agents: any[]
  queries: any[]
  readOnly?: boolean
}) {
  const Icon = ICONS[def.icon]
  const tone = CATEGORY_TONE[def.category] ?? CATEGORY_TONE.Mensagens!
  const cfg = node.data.config ?? {}
  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-start gap-3 border-b border-line px-4 py-4">
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-[8px]', tone.chip)}>{Icon && <Icon className="size-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">{def.label}</div>
          <div className="text-[12px] leading-snug text-muted">{def.description}</div>
        </div>
        <IconButton label="Fechar" onClick={onClose} className="-mr-1 size-8">
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {issues.length > 0 && (
          <div className="space-y-1">
            {issues.map((i, k) => (
              <div key={k} className={cx('rounded-[8px] px-2.5 py-1.5 text-[12px]', i.level === 'error' ? 'bg-coral-soft text-coral-ink' : 'bg-warn/12 text-warn')}>
                {i.message}
              </div>
            ))}
          </div>
        )}
        {def.type !== 'start' && (
          <Field label="Nome no desenho (opcional)">
            <Input value={cfg.title ?? ''} onChange={(e) => onChange({ ...cfg, title: e.target.value })} placeholder={def.label} disabled={readOnly} />
          </Field>
        )}
        <fieldset disabled={readOnly} className="space-y-4">
          {def.fields.map((f: any) => (
            <Field key={f.key} label={f.label + (f.required ? ' *' : '')} hint={f.help}>
              <FieldInput spec={f} value={cfg[f.key]} onChange={(v) => onChange({ ...cfg, [f.key]: v })} agents={agents} queries={queries} />
            </Field>
          ))}
        </fieldset>
        {['message', 'question', 'menu', 'transfer', 'close', 'http', 'set_variable', 'ai_agent'].includes(def.type) && (
          <div className="rounded-[8px] bg-panel-2 px-3 py-2 text-[11.5px] leading-relaxed text-muted">
            Variáveis: <code>{'{{contato.primeiro_nome}}'}</code> <code>{'{{contato.nome}}'}</code> <code>{'{{contato.telefone}}'}</code> <code>{'{{contato.email}}'}</code>{' '}
            <code>{'{{contato.score}}'}</code> e qualquer variável guardada por perguntas, como <code>{'{{email}}'}</code>.
          </div>
        )}
      </div>
      {def.type !== 'start' && !readOnly && (
        <div className="border-t border-line px-4 py-3">
          <Button variant="danger" size="sm" icon={<Trash2 className="size-4" />} onClick={onDelete}>
            Excluir nó
          </Button>
        </div>
      )}
    </aside>
  )
}
