import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Globe, Plus, RefreshCw, Search, Trash2, Type, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge, Button, Dialog, Empty, Field, IconButton, Input, PageHeader, PixelGlyph, Section, Switch, Table, Tabs, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { ago } from '../../lib/format'
import { useSession } from '../../lib/session'

type Tab = 'docs' | 'faq' | 'test'

export function KnowledgePage() {
  const [tab, setTab] = useState<Tab>('docs')
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-[1080px]">
        <PageHeader
          title="Base de conhecimento"
          description="Tudo que a IA pode usar para responder. Se não estiver aqui, ela não inventa: transfere para um especialista."
        />
        <div className="mb-6 max-w-md">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'docs', label: 'Documentos' },
              { value: 'faq', label: 'Perguntas frequentes' },
              { value: 'test', label: 'Testar a base' },
            ]}
          />
        </div>
        {tab === 'docs' && <DocumentsTab />}
        {tab === 'faq' && <FaqTab />}
        {tab === 'test' && <TestTab />}
      </div>
    </div>
  )
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'coral' | 'neutral' }> = {
  ready: { label: 'Pronto', tone: 'ok' },
  processing: { label: 'Processando', tone: 'warn' },
  pending: { label: 'Na fila', tone: 'warn' },
  error: { label: 'Erro', tone: 'coral' },
}

function DocumentsTab() {
  const { me } = useSession()
  const canEdit = !!me?.user.permissions.kbEdit
  const qc = useQueryClient()
  const docs = useQuery({
    queryKey: ['kb-docs'],
    queryFn: () => api.get<any[]>('/api/kb/documents'),
    refetchInterval: (q) => ((q.state.data as any[] | undefined)?.some((d) => d.status === 'pending' || d.status === 'processing') ? 2500 : false),
  })
  const [adding, setAdding] = useState<'text' | 'site' | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      const form = new FormData()
      form.append('file', f)
      try {
        await api.upload('/api/kb/documents/upload', form)
        toast.success(`"${f.name}" enviado. Indexando…`)
      } catch (e: any) {
        toast.error(`${f.name}: ${e.message}`)
      }
    }
    qc.invalidateQueries({ queryKey: ['kb-docs'] })
  }
  return (
    <div className="space-y-4">
      {canEdit && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-[12px] border border-dashed border-line-strong bg-panel p-5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files)
          }}
        >
          <Upload className="size-5 text-muted" />
          <div className="flex-1 text-[13.5px] text-ink-2">Arraste PDFs, DOCX, TXT ou Markdown aqui — material institucional, ofertas, regulamentos, explicações sobre tokenização.</div>
          <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.txt,.md,.html" onChange={(e) => e.target.files && void upload(e.target.files)} />
          <Button icon={<FileText className="size-4" />} onClick={() => fileRef.current?.click()}>
            Enviar arquivo
          </Button>
          <Button icon={<Type className="size-4" />} onClick={() => setAdding('text')}>
            Colar texto
          </Button>
          <Button icon={<Globe className="size-4" />} onClick={() => setAdding('site')}>
            Página do site
          </Button>
        </div>
      )}
      <div className="rounded-[12px] border border-line bg-panel">
        {!docs.data?.length ? (
          <Empty title="Nenhum documento ainda" glyph={<PixelGlyph pattern="ai" size={40} className="text-line-strong" />}>
            Comece pelo material que o time mais usa para explicar a empresa: serviços, prazos, formas de pagamento.
          </Empty>
        ) : (
          <Table head={['Documento', 'Origem', 'Situação', 'Trechos', 'Atualizado', '']}>
            {docs.data.map((d) => (
              <tr key={d.id} className={d.active ? '' : 'opacity-50'}>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-ink">{d.title}</div>
                  {d.error && <div className="text-[12px] text-coral-ink">{d.error}</div>}
                  {d.url && <div className="truncate text-[12px] text-muted">{d.url}</div>}
                </td>
                <td className="px-3 py-2.5 text-[12.5px] text-ink-2">{d.source === 'upload' ? d.filename : d.source === 'site' ? `Site${d.refresh_days ? ` · a cada ${d.refresh_days}d` : ''}` : 'Texto'}</td>
                <td className="px-3 py-2.5">
                  <Badge tone={STATUS[d.status]?.tone}>{STATUS[d.status]?.label}</Badge>
                </td>
                <td className="px-3 py-2.5 text-ink-2">{d.chunks}</td>
                <td className="px-3 py-2.5 text-[12.5px] text-muted">{ago(d.updated_at)}</td>
                <td className="px-3 py-2.5 text-right">
                  {canEdit && (
                    <div className="flex justify-end gap-1">
                      <IconButton label={d.active ? 'Desativar' : 'Ativar'} onClick={() => api.patch(`/api/kb/documents/${d.id}`, { active: !d.active }).then(() => qc.invalidateQueries({ queryKey: ['kb-docs'] }))}>
                        <Switch checked={d.active} onChange={() => {}} />
                      </IconButton>
                      <IconButton label="Reindexar" onClick={() => api.post(`/api/kb/documents/${d.id}/reindex`).then(() => qc.invalidateQueries({ queryKey: ['kb-docs'] }))}>
                        <RefreshCw className="size-4" />
                      </IconButton>
                      <IconButton
                        label="Excluir"
                        onClick={async () => {
                          if (!confirm(`Excluir "${d.title}" da base?`)) return
                          await api.del(`/api/kb/documents/${d.id}`)
                          qc.invalidateQueries({ queryKey: ['kb-docs'] })
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      {adding && <AddDocDialog mode={adding} onClose={() => setAdding(null)} onDone={() => qc.invalidateQueries({ queryKey: ['kb-docs'] })} />}
    </div>
  )
}

function AddDocDialog({ mode, onClose, onDone }: { mode: 'text' | 'site'; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('https://')
  const [refresh, setRefresh] = useState(7)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open
      onClose={onClose}
      width={640}
      title={mode === 'text' ? 'Colar texto' : 'Página do site'}
      description={mode === 'site' ? 'A página é lida agora e de novo periodicamente, para a base acompanhar o que está publicado.' : 'Use títulos com # para organizar os assuntos.'}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title || (mode === 'text' ? text.length < 20 : !url)}
            onClick={async () => {
              setBusy(true)
              try {
                await api.post('/api/kb/documents', mode === 'text' ? { title, text } : { title, url, refreshDays: refresh })
                onDone()
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Adicionar à base
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Título">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'site' ? 'Site institucional — página inicial' : 'Como funciona a tokenização'} />
        </Field>
        {mode === 'text' ? (
          <Field label="Conteúdo">
            <Textarea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={'# Nossos serviços\n...\n\n# Prazos e formas de pagamento\n...'} />
          </Field>
        ) : (
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <Field label="Endereço">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Atualizar a cada (dias)">
              <Input type="number" min={1} max={90} value={refresh} onChange={(e) => setRefresh(Number(e.target.value))} />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  )
}

function FaqTab() {
  const { me } = useSession()
  const canEdit = !!me?.user.permissions.kbEdit
  const qc = useQueryClient()
  const faq = useQuery({ queryKey: ['kb-faq'], queryFn: () => api.get<any[]>('/api/kb/faq') })
  const [editing, setEditing] = useState<any | null>(null)
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-[13.5px] text-muted">Perguntas frequentes têm prioridade sobre os documentos. Use para corrigir uma resposta da IA na hora ou fixar a resposta oficial de um tema.</p>
        {canEdit && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({ question: '', answer: '', keywords: '', active: true })}>
            Nova pergunta
          </Button>
        )}
      </div>
      {!faq.data?.length ? (
        <div className="rounded-[12px] border border-line bg-panel">
          <Empty title="Nenhuma pergunta cadastrada" />
        </div>
      ) : (
        <div className="space-y-2">
          {faq.data.map((f) => (
            <button key={f.id} onClick={() => canEdit && setEditing(f)} className="block w-full rounded-[12px] border border-line bg-panel p-4 text-left hover:border-line-strong">
              <div className="flex items-start justify-between gap-3">
                <div className="font-medium text-ink">{f.question}</div>
                {!f.active && <Badge>inativa</Badge>}
              </div>
              <p className="mt-1 line-clamp-2 text-[13px] text-ink-2">{f.answer}</p>
            </button>
          ))}
        </div>
      )}
      {editing && (
        <FaqDialog item={editing} onClose={() => setEditing(null)} onDone={() => qc.invalidateQueries({ queryKey: ['kb-faq'] })} />
      )}
    </div>
  )
}

function FaqDialog({ item, onClose, onDone }: { item: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ question: item.question, answer: item.answer, keywords: item.keywords ?? '', active: item.active ?? true })
  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={item.id ? 'Editar pergunta' : 'Nova pergunta frequente'}
      footer={
        <>
          {item.id && (
            <Button
              variant="danger"
              className="mr-auto"
              onClick={async () => {
                await api.del(`/api/kb/faq/${item.id}`)
                onDone()
                onClose()
              }}
            >
              Excluir
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={!f.question || !f.answer}
            onClick={async () => {
              try {
                if (item.id) await api.put(`/api/kb/faq/${item.id}`, f)
                else await api.post('/api/kb/faq', f)
                onDone()
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
        <Field label="Pergunta">
          <Input value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder="Qual o valor mínimo para investir?" />
        </Field>
        <Field label="Resposta oficial">
          <Textarea rows={6} value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} />
        </Field>
        <Field label="Palavras-chave (opcional)" hint="Outras formas de perguntar: aporte mínimo, menor valor, quanto preciso…">
          <Input value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} />
        </Field>
        <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="Ativa" />
      </div>
    </Dialog>
  )
}

function TestTab() {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Section title="O que a IA veria" description="Digite uma pergunta como um cliente faria. Mostramos os trechos que seriam enviados ao agente como contexto.">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            setResult(await api.post('/api/kb/search', { query }))
          } catch (err: any) {
            toast.error(err.message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Qual o prazo para resgatar o investimento?" />
        <Button variant="primary" icon={<Search className="size-4" />} loading={busy}>
          Buscar
        </Button>
      </form>
      {result && (
        <div className="mt-5 space-y-3">
          {!result.hits.length && <p className="text-[13.5px] text-coral-ink">Nada encontrado — a IA transferiria esta pergunta para um humano (motivo: sem resposta na base).</p>}
          {result.hits.map((h: any, i: number) => (
            <div key={i} className="rounded-[10px] border border-line p-3">
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                <Badge tone={h.source === 'faq' ? 'coral' : 'ai'}>{h.source === 'faq' ? 'FAQ' : 'Documento'}</Badge>
                <span className="font-medium text-ink">{h.title}</span>
              </div>
              <p className="whitespace-pre-wrap text-[13px] text-ink-2">{h.content}</p>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}
