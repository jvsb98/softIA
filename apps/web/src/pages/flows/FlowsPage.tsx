import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Copy, Plus, Workflow } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, cx, Dialog, Empty, Field, IconButton, Input, PageHeader, PixelGlyph, Textarea } from '@/components/ui'
import { api } from '@/lib/api'
import { ago } from '@/lib/format'

export function FlowsPage() {
  const flows = useQuery({ queryKey: ['flows'], queryFn: () => api.get<any[]>('/api/flows') })
  const [creating, setCreating] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-[1080px]">
        <PageHeader
          title="Fluxos de atendimento"
          description="Monte visualmente o caminho das conversas: mensagens, perguntas, menus, agente de IA e transferências. Cada conexão usa um fluxo de entrada."
          actions={
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Novo fluxo
            </Button>
          }
        />
        {!flows.data?.length ? (
          <div className="rounded-[12px] border border-line bg-panel">
            <Empty
              title={flows.isLoading ? 'Carregando…' : 'Nenhum fluxo ainda'}
              glyph={<PixelGlyph pattern="flow" size={44} className="text-line-strong" />}
              action={!flows.isLoading && <Button variant="primary" onClick={() => setCreating(true)}>Começar por um modelo</Button>}
            >
              Sem fluxo, as conversas são atendidas direto pelo agente de IA padrão.
            </Empty>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {flows.data.map((f) => (
              <div key={f.id} className={cx('group rounded-[12px] border border-line bg-panel p-5 shadow-panel', f.archived && 'opacity-60')}>
                <button className="block w-full text-left" onClick={() => navigate(`/fluxos/${f.id}`)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="flex size-10 items-center justify-center rounded-[10px] bg-navy text-linen dark:bg-linen dark:text-navy">
                        <Workflow className="size-5" />
                      </span>
                      <div>
                        <div className="font-semibold text-ink">{f.name}</div>
                        <div className="text-[12.5px] text-muted">{f.description || 'Sem descrição'}</div>
                      </div>
                    </div>
                    {f.published_version ? <Badge tone="ok">v{f.published_version} publicada</Badge> : <Badge>rascunho</Badge>}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted">
                    <span>{f.connections.length ? `Entrada de: ${f.connections.join(', ')}` : 'Não usado por nenhuma conexão'}</span>
                    <span>{f.runs_7d} execuções em 7 dias</span>
                    {f.active_runs > 0 && <span>{f.active_runs} em andamento</span>}
                    {f.has_unpublished_changes && <span className="text-warn">alterações não publicadas</span>}
                    <span>editado {ago(f.draft_updated_at)}{f.draft_updated_by_name ? ` por ${f.draft_updated_by_name}` : ''}</span>
                  </div>
                </button>
                <div className="mt-3 flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <IconButton
                    label="Duplicar"
                    onClick={async () => {
                      const r = await api.post(`/api/flows/${f.id}/duplicate`)
                      qc.invalidateQueries({ queryKey: ['flows'] })
                      navigate(`/fluxos/${r.id}`)
                    }}
                  >
                    <Copy className="size-4" />
                  </IconButton>
                  <IconButton
                    label={f.archived ? 'Restaurar' : 'Arquivar'}
                    onClick={() =>
                      api
                        .post(`/api/flows/${f.id}/archive`, { archived: !f.archived })
                        .then(() => qc.invalidateQueries({ queryKey: ['flows'] }))
                        .catch((e) => toast.error(e.message))
                    }
                  >
                    <Archive className="size-4" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && <NewFlowDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewFlowDialog({ onClose }: { onClose: () => void }) {
  const templates = useQuery({ queryKey: ['flow-templates'], queryFn: () => api.get<any[]>('/api/flows/templates') })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [templateId, setTemplateId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  const qc = useQueryClient()
  return (
    <Dialog
      open
      onClose={onClose}
      width={680}
      title="Novo fluxo"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api.post('/api/flows', { name, description: description || undefined, templateId: templateId || undefined })
                qc.invalidateQueries({ queryKey: ['flows'] })
                navigate(`/fluxos/${r.id}`)
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Criar e abrir
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entrada comercial" />
        </Field>
        <Field label="Descrição (opcional)">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div>
          <div className="mb-2 text-[13px] font-medium text-ink-2">Começar com</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <TemplateCard selected={!templateId} onClick={() => setTemplateId('')} title="Fluxo em branco" description="Só o nó de início." />
            {(templates.data ?? []).map((t) => (
              <TemplateCard
                key={t.id}
                selected={templateId === t.id}
                onClick={() => {
                  setTemplateId(t.id)
                  if (!name) setName(t.name)
                }}
                title={t.name}
                description={t.description}
              />
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}

function TemplateCard({ selected, onClick, title, description }: { selected: boolean; onClick: () => void; title: string; description: string }) {
  return (
    <button onClick={onClick} className={cx('rounded-[10px] border p-3 text-left transition-colors', selected ? 'border-coral bg-coral-soft' : 'border-line hover:border-line-strong')}>
      <div className="text-[13.5px] font-medium text-ink">{title}</div>
      <div className="mt-0.5 text-[12px] leading-snug text-muted">{description}</div>
    </button>
  )
}
