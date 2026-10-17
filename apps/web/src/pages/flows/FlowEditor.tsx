import '@xyflow/react/dist/style.css'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react'
import { ArrowLeft, BarChart3, CheckCircle2, FlaskConical, History, Rocket, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge, Button, cx, Dialog, Field, Spinner, Textarea } from '../../components/ui'
import { api } from '../../lib/api'
import { ago, dateTime } from '../../lib/format'
import { useSectors } from '../../lib/queries'
import { useSession } from '../../lib/session'
import { getThemePref } from '../../lib/theme'
import { CATEGORY_TONE, FlowNodeView, ICONS, summarize, type FlowNodeData } from './FlowNode'
import { Inspector } from './Inspector'
import { SimulatorPanel, type SimView } from './SimulatorPanel'

const nodeTypes = { na: FlowNodeView }
const CATEGORIES = ['Mensagens', 'Lógica', 'Inteligência artificial', 'Ações', 'Integrações']

function outputsFor(def: any, config: Record<string, any>) {
  const dyn: { id: string; label: string }[] = []
  if (def.type === 'menu') (config.options ?? []).forEach((o: any, i: number) => dyn.push({ id: `opt_${i}`, label: o.label || `Opção ${i + 1}` }))
  if (def.type === 'condition') (config.rules ?? []).forEach((r: any, i: number) => dyn.push({ id: `rule_${i}`, label: r.label || `Regra ${i + 1}` }))
  if (def.type === 'ai_classify') (config.categories ?? []).forEach((c: any, i: number) => dyn.push({ id: `cat_${i}`, label: c.name || `Categoria ${i + 1}` }))
  return [...dyn, ...def.outputs]
}

let uid = 0
const newId = (type: string) => `${type}_${Date.now().toString(36)}${(uid++).toString(36)}`

function Editor() {
  const { id } = useParams()
  const { me } = useSession()
  const qc = useQueryClient()
  const rf = useReactFlow()
  const canEdit = !!me?.user.permissions.flowsEdit
  const canAdvanced = !!me?.user.permissions.flowsAdvanced
  const flow = useQuery({ queryKey: ['flow', id], queryFn: () => api.get<any>(`/api/flows/${id}`) })
  const types = useQuery({ queryKey: ['node-types'], queryFn: () => api.get<any[]>('/api/flows/node-types'), staleTime: Infinity })
  const agents = useQuery({ queryKey: ['ai-agents'], queryFn: () => api.get<any[]>('/api/ai/agents') })
  const queries = useQuery({ queryKey: ['saved-queries-lite'], queryFn: () => api.get<any[]>('/api/integrations/queries').catch(() => []) })
  const sectors = useSectors()

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [issues, setIssues] = useState<any[]>([])
  const [saveState, setSaveState] = useState<{ saving: boolean; at: string | null; dirty: boolean }>({ saving: false, at: null, dirty: false })
  const [panel, setPanel] = useState<'inspector' | 'sim' | 'versions' | null>(null)
  const [metricsOn, setMetricsOn] = useState(false)
  const [sim, setSim] = useState<SimView | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const loaded = useRef(false)
  const wrapper = useRef<HTMLDivElement>(null)

  const typeMap = useMemo(() => new Map((types.data ?? []).map((t) => [t.type, t])), [types.data])

  const metrics = useQuery({
    queryKey: ['flow-metrics', id],
    queryFn: () => api.get<any>(`/api/flows/${id}/metrics?days=30`),
    enabled: metricsOn,
  })

  // ---------- carregar
  useEffect(() => {
    if (!flow.data || !types.data || loaded.current) return
    loaded.current = true
    const d = flow.data.draft ?? { nodes: [], edges: [] }
    setNodes(
      d.nodes.map((n: any) => ({
        id: n.id,
        type: 'na',
        position: n.position ?? { x: 0, y: 0 },
        deletable: n.type !== 'start',
        data: { nodeType: n.type, config: n.data ?? {} },
      })),
    )
    setEdges(d.edges.map((e: any) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'next', target: e.target, type: 'smoothstep' })))
    setSaveState({ saving: false, at: flow.data.draft_updated_at, dirty: false })
    setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1 }), 50)
  }, [flow.data, types.data, rf])

  const toDefinition = useCallback(
    () => ({
      nodes: nodes.map((n) => ({ id: n.id, type: (n.data as any).nodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: (n.data as any).config ?? {} })),
      edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'next', target: e.target })),
    }),
    [nodes, edges],
  )

  // ---------- salvar automaticamente
  const save = useCallback(async () => {
    if (!canEdit) return
    setSaveState((s) => ({ ...s, saving: true }))
    try {
      const r = await api.put(`/api/flows/${id}/draft`, { draft: toDefinition() })
      setSaveState({ saving: false, at: r.savedAt, dirty: false })
      setIssues(await api.post(`/api/flows/${id}/validate`))
    } catch (e: any) {
      setSaveState((s) => ({ ...s, saving: false }))
      toast.error(e.message)
    }
  }, [id, toDefinition, canEdit])

  useEffect(() => {
    if (!saveState.dirty) return
    const t = setTimeout(() => void save(), 1200)
    return () => clearTimeout(t)
  }, [saveState.dirty, nodes, edges, save])

  useEffect(() => {
    if (loaded.current && id) api.post(`/api/flows/${id}/validate`).then(setIssues).catch(() => {})
  }, [id, flow.data])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  const markDirty = () => setSaveState((s) => ({ ...s, dirty: true }))

  // ---------- eventos do canvas
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const filtered = canEdit ? changes : changes.filter((c) => c.type === 'select' || c.type === 'dimensions')
      setNodes((ns) => applyNodeChanges(filtered, ns))
      if (filtered.some((c) => c.type === 'position' && !c.dragging) || filtered.some((c) => c.type === 'remove')) markDirty()
      const sel = filtered.find((c) => c.type === 'select' && c.selected) as any
      if (sel) {
        setSelected(sel.id)
        setPanel((p) => (p === 'sim' ? p : 'inspector'))
      }
    },
    [canEdit],
  )
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!canEdit) return
      setEdges((es) => applyEdgeChanges(changes, es))
      if (changes.some((c) => c.type === 'remove')) markDirty()
    },
    [canEdit],
  )
  const onConnect = useCallback(
    (c: Connection) => {
      if (!canEdit || !c.source || !c.target || c.source === c.target) return
      setEdges((es) => [
        // cada saída liga em um único destino
        ...es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? 'next') === (c.sourceHandle ?? 'next'))),
        { id: `e-${c.source}-${c.sourceHandle ?? 'next'}-${c.target}`, source: c.source, sourceHandle: c.sourceHandle ?? 'next', target: c.target, type: 'smoothstep' },
      ])
      markDirty()
    },
    [canEdit],
  )

  const addNode = (type: string, position?: { x: number; y: number }) => {
    const def = typeMap.get(type)
    if (!def || !canEdit) return
    if (def.advanced && !canAdvanced) return toast.error('Você não tem permissão para nós avançados.')
    if (type === 'start' && nodes.some((n) => (n.data as any).nodeType === 'start')) return toast.error('O fluxo já tem um nó de início.')
    const config: Record<string, any> = {}
    for (const f of def.fields) if (f.default !== undefined) config[f.key] = f.default
    const pos = position ?? rf.screenToFlowPosition({ x: (wrapper.current?.clientWidth ?? 800) / 2, y: (wrapper.current?.clientHeight ?? 600) / 2 })
    const nid = newId(type)
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: nid, type: 'na', position: pos, selected: true, data: { nodeType: type, config } }])
    setSelected(nid)
    setPanel('inspector')
    markDirty()
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const type = e.dataTransfer.getData('application/na-node')
    if (type) addNode(type, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  // ---------- dados exibidos nos nós
  const lookups = { sectors: sectors.data ?? [], agents: agents.data ?? [] }
  const activeNode = sim?.currentNodeId
  const visited = new Set(sim?.visited ?? [])
  const displayNodes: Node[] = nodes.map((n) => {
    const t = typeMap.get((n.data as any).nodeType)
    const config = (n.data as any).config ?? {}
    const m = metricsOn && metrics.data ? metrics.data.nodes?.[n.id] : null
    const edgeCounts: Record<string, number> = {}
    if (metricsOn && metrics.data) for (const [k, v] of Object.entries(metrics.data.edges ?? {})) if (k.startsWith(n.id + ':')) edgeCounts[k.slice(n.id.length + 1)] = v as number
    const data: FlowNodeData = {
      ...(n.data as any),
      def: t ?? { label: (n.data as any).nodeType, outputs: [], fields: [] },
      config,
      outputs: t ? outputsFor(t, config) : [],
      summary: summarize((n.data as any).nodeType, config, lookups),
      issues: issues.filter((i) => i.nodeId === n.id),
      metrics: metricsOn ? { entered: m?.entered ?? 0, stalled: m?.stalled ?? 0, edges: edgeCounts } : null,
      active: activeNode === n.id,
      visited: visited.has(n.id),
    }
    return { ...n, data }
  })
  const displayEdges: Edge[] = edges.map((e) => {
    const hot = sim && visited.has(e.source) && visited.has(e.target)
    return {
      ...e,
      animated: !!hot,
      style: { stroke: hot ? 'var(--coral)' : 'var(--line-strong)', strokeWidth: hot ? 2.2 : 1.6 },
      label: metricsOn && metrics.data ? String(metrics.data.edges?.[`${e.source}:${e.sourceHandle ?? 'next'}`] ?? 0) : undefined,
      labelStyle: { fontSize: 11, fill: 'var(--muted)' },
      labelBgStyle: { fill: 'var(--panel)' },
    }
  })

  const selectedNode = nodes.find((n) => n.id === selected)
  const selectedDef = selectedNode ? typeMap.get((selectedNode.data as any).nodeType) : null
  const errors = issues.filter((i) => i.level === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')

  if (flow.isLoading || types.isLoading) return <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>
  if (!flow.data) return <div className="p-8 text-muted">Fluxo não encontrado.</div>

  return (
    <div className="flex h-full flex-col">
      {/* ---------------- barra superior */}
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <Link to="/fluxos" className="flex size-9 items-center justify-center rounded-[8px] text-ink-2 hover:bg-panel-2" aria-label="Voltar para fluxos">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <input
            defaultValue={flow.data.name}
            disabled={!canEdit}
            onBlur={(e) => e.target.value !== flow.data.name && api.put(`/api/flows/${id}/draft`, { draft: toDefinition(), name: e.target.value }).then(() => qc.invalidateQueries({ queryKey: ['flows'] }))}
            className="w-[320px] truncate rounded-[6px] bg-transparent px-1 font-display text-[19px] text-ink outline-none hover:bg-panel-2 focus:bg-panel-2"
            aria-label="Nome do fluxo"
          />
          <div className="px-1 text-[11.5px] text-muted">
            {flow.data.published_version ? `v${flow.data.published_version} publicada ${ago(flow.data.published_at)}` : 'Ainda não publicado'} ·{' '}
            {saveState.saving ? 'salvando…' : saveState.dirty ? 'alterações não salvas' : saveState.at ? `rascunho salvo ${ago(saveState.at)}` : ''}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {issues.length > 0 && (
            <button onClick={() => setPanel('inspector')} className="text-[12.5px]">
              {errors.length > 0 ? <Badge tone="coral">{errors.length} erro(s)</Badge> : <Badge tone="warn">{warnings.length} aviso(s)</Badge>}
            </button>
          )}
          {issues.length === 0 && nodes.length > 1 && (
            <span className="flex items-center gap-1 text-[12.5px] text-ok">
              <CheckCircle2 className="size-4" /> pronto para publicar
            </span>
          )}
          <Button size="sm" variant={metricsOn ? 'primary' : 'secondary'} icon={<BarChart3 className="size-4" />} onClick={() => setMetricsOn(!metricsOn)}>
            Métricas
          </Button>
          <Button size="sm" variant={panel === 'versions' ? 'primary' : 'secondary'} icon={<History className="size-4" />} onClick={() => setPanel(panel === 'versions' ? null : 'versions')}>
            Versões
          </Button>
          <Button size="sm" variant="ai" icon={<FlaskConical className="size-4" />} onClick={() => setPanel(panel === 'sim' ? null : 'sim')}>
            Simular
          </Button>
          {canEdit && (
            <Button size="sm" variant="primary" icon={<Rocket className="size-4" />} onClick={async () => (await save(), setPublishOpen(true))}>
              Publicar
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- paleta */}
        {canEdit && (
          <aside className="flex w-[232px] shrink-0 flex-col border-r border-line bg-panel">
            <div className="p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Buscar bloco"
                  className="h-8 w-full rounded-[7px] border border-line bg-bg pl-7 pr-2 text-[12.5px] text-ink outline-none"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
              {CATEGORIES.map((cat) => {
                const items = (types.data ?? []).filter(
                  (t) => t.category === cat && t.type !== 'start' && (!t.advanced || canAdvanced) && (!filter || `${t.label} ${t.description}`.toLowerCase().includes(filter.toLowerCase())),
                )
                if (!items.length) return null
                const tone = CATEGORY_TONE[cat]!
                return (
                  <div key={cat}>
                    <div className="mb-1.5 px-1 text-[11.5px] font-medium text-muted">{cat}</div>
                    <div className="space-y-1">
                      {items.map((t) => {
                        const Icon = ICONS[t.icon]
                        return (
                          <button
                            key={t.type}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData('application/na-node', t.type)}
                            onClick={() => addNode(t.type)}
                            title={t.description}
                            className="flex w-full items-center gap-2 rounded-[8px] border border-transparent px-1.5 py-1.5 text-left hover:border-line hover:bg-panel-2"
                          >
                            <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-[6px]', tone.chip)}>{Icon && <Icon className="size-3.5" />}</span>
                            <span className="truncate text-[12.5px] text-ink">{t.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
              <p className="px-1 text-[11px] leading-relaxed text-muted">Arraste um bloco para o desenho ou clique para adicionar. Ligue a bolinha de uma saída à entrada do próximo bloco.</p>
            </div>
          </aside>
        )}

        {/* ---------------- canvas */}
        <div ref={wrapper} className="relative min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneClick={() => {
              setSelected(null)
              if (panel === 'inspector') setPanel(null)
            }}
            colorMode={document.documentElement.dataset.theme === 'dark' || (getThemePref() === 'dark') ? 'dark' : 'light'}
            deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            minZoom={0.2}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--line-strong)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable nodeColor={() => 'var(--line-strong)'} maskColor="rgb(0 0 0 / 0.06)" position="bottom-right" />
          </ReactFlow>
          {metricsOn && metrics.data?.runs && (
            <div className="absolute left-4 top-4 rounded-[10px] border border-line bg-panel px-3 py-2 text-[12px] text-ink-2 shadow-panel">
              Últimos 30 dias (versão publicada): <b>{metrics.data.runs.total}</b> execuções · {metrics.data.runs.transferred} transferidas · {metrics.data.runs.done} concluídas ·{' '}
              {metrics.data.runs.active} em andamento · {metrics.data.runs.failed} com erro
            </div>
          )}
        </div>

        {/* ---------------- painéis */}
        {panel === 'inspector' && selectedNode && selectedDef && (
          <Inspector
            key={selectedNode.id}
            node={selectedNode}
            def={selectedDef}
            issues={issues.filter((i) => i.nodeId === selectedNode.id)}
            agents={agents.data ?? []}
            queries={queries.data ?? []}
            readOnly={!canEdit || (selectedDef.advanced && !canAdvanced)}
            onChange={(config) => {
              setNodes((ns) => ns.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, config } } : n)))
              markDirty()
            }}
            onDelete={() => {
              setNodes((ns) => ns.filter((n) => n.id !== selectedNode.id))
              setEdges((es) => es.filter((e) => e.source !== selectedNode.id && e.target !== selectedNode.id))
              setSelected(null)
              setPanel(null)
              markDirty()
            }}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === 'inspector' && !selectedNode && issues.length > 0 && (
          <aside className="w-[340px] shrink-0 space-y-2 overflow-y-auto border-l border-line bg-panel p-4">
            <div className="text-[14px] font-semibold text-ink">Validação</div>
            {issues.map((i, k) => (
              <button
                key={k}
                onClick={() => {
                  if (!i.nodeId) return
                  setSelected(i.nodeId)
                  const n = nodes.find((x) => x.id === i.nodeId)
                  if (n) rf.setCenter(n.position.x + 120, n.position.y + 60, { zoom: 1, duration: 300 })
                }}
                className={cx('block w-full rounded-[8px] px-2.5 py-2 text-left text-[12.5px]', i.level === 'error' ? 'bg-coral-soft text-coral-ink' : 'bg-warn/12 text-warn')}
              >
                {i.message}
              </button>
            ))}
          </aside>
        )}
        {panel === 'sim' && <SimulatorPanel flowId={id!} getDraft={toDefinition} onView={setSim} onClose={() => setPanel(null)} />}
        {panel === 'versions' && (
          <VersionsPanel
            flowId={id!}
            publishedId={flow.data.published_version_id}
            canEdit={canEdit}
            onRestored={() => {
              loaded.current = false
              qc.invalidateQueries({ queryKey: ['flow', id] })
            }}
          />
        )}
      </div>

      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        flowId={id!}
        issues={issues}
        onPublished={() => qc.invalidateQueries({ queryKey: ['flow', id] })}
      />
    </div>
  )
}

function PublishDialog({ open, onClose, flowId, issues, onPublished }: { open: boolean; onClose: () => void; flowId: string; issues: any[]; onPublished: () => void }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const errors = issues.filter((i) => i.level === 'error')
  const warnings = issues.filter((i) => i.level === 'warning')
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publicar fluxo"
      description="As novas conversas passam a usar esta versão. Conversas que já estão no meio do fluxo terminam na versão em que começaram."
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            disabled={errors.length > 0}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api.post(`/api/flows/${flowId}/publish`, { note: note || undefined })
                toast.success(`Versão ${r.version} publicada.`)
                onPublished()
                onClose()
              } catch (e: any) {
                toast.error(e.message)
              } finally {
                setBusy(false)
              }
            }}
          >
            Publicar
          </Button>
        </>
      }
    >
      {errors.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[13px] text-ink">Corrija antes de publicar:</p>
          {errors.map((e, i) => (
            <div key={i} className="rounded-[8px] bg-coral-soft px-2.5 py-1.5 text-[12.5px] text-coral-ink">
              {e.message}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {warnings.length > 0 && (
            <div className="space-y-1">
              {warnings.map((w, i) => (
                <div key={i} className="rounded-[8px] bg-warn/12 px-2.5 py-1.5 text-[12.5px] text-warn">
                  {w.message}
                </div>
              ))}
            </div>
          )}
          <Field label="O que mudou nesta versão? (opcional)">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: nova pergunta sobre prazo antes do agente." />
          </Field>
        </div>
      )}
    </Dialog>
  )
}

function VersionsPanel({ flowId, publishedId, canEdit, onRestored }: { flowId: string; publishedId: string | null; canEdit: boolean; onRestored: () => void }) {
  const versions = useQuery({ queryKey: ['flow-versions', flowId], queryFn: () => api.get<any[]>(`/api/flows/${flowId}/versions`) })
  const restore = async (v: any, publish: boolean) => {
    if (!confirm(publish ? `Voltar a publicação para a versão ${v.version}? O rascunho também volta para ela.` : `Substituir o rascunho atual pela versão ${v.version}?`)) return
    await api.post(`/api/flows/${flowId}/versions/${v.id}/restore`, { publish })
    toast.success(publish ? `Versão ${v.version} publicada novamente.` : 'Rascunho restaurado.')
    onRestored()
  }
  return (
    <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-line bg-panel p-4">
      <div className="mb-3 text-[14px] font-semibold text-ink">Histórico de versões</div>
      {!versions.data?.length ? (
        <p className="text-[13px] text-muted">Nenhuma versão publicada ainda.</p>
      ) : (
        <ul className="space-y-2">
          {versions.data.map((v) => (
            <li key={v.id} className={cx('rounded-[10px] border p-3', v.id === publishedId ? 'border-ok/50 bg-ok/5' : 'border-line')}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">Versão {v.version}</span>
                {v.id === publishedId && <Badge tone="ok">em uso</Badge>}
              </div>
              <div className="mt-0.5 text-[12px] text-muted">
                {dateTime(v.published_at)} · {v.published_by_name ?? '—'} · {v.runs} execuções
              </div>
              {v.note && <p className="mt-1.5 text-[12.5px] text-ink-2">{v.note}</p>}
              {canEdit && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => void restore(v, false)}>
                    Abrir no rascunho
                  </Button>
                  {v.id !== publishedId && (
                    <Button size="sm" variant="danger" onClick={() => void restore(v, true)}>
                      Voltar para esta
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

export function FlowEditorPage() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  )
}
