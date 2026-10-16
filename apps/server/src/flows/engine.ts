/**
 * Motor de execução de fluxos — independente de banco (usado pelo atendimento real e pelo simulador).
 */
import { getPath, nodeTypeMap, scopeFor } from './nodes.js'
import type { FlowDefinition, FlowIO, NodeContext, RunState } from './types.js'

export const MAX_STEPS = 40

export interface ExecResult {
  status: 'waiting' | 'done' | 'transferred' | 'closed' | 'failed'
  state: RunState
  steps: { nodeId: string; type: string; handle: string | null }[]
  error?: string
}

export function startNode(def: FlowDefinition) {
  return def.nodes.find((n) => n.type === 'start') ?? null
}

function nextNodeId(def: FlowDefinition, nodeId: string, handle: string): string | null {
  const e = def.edges.find((x) => x.source === nodeId && (x.sourceHandle ?? 'next') === handle)
  return e?.target ?? null
}

export function makeInterpolate(ctxRef: () => NodeContext) {
  return async (template: string, jsonEscape = false) => {
    if (!template.includes('{{')) return template
    const scope = await scopeFor(ctxRef())
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
      const v = getPath(scope, path)
      const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
      return jsonEscape ? JSON.stringify(s).slice(1, -1) : s
    })
  }
}

/**
 * Executa o fluxo a partir do nó atual.
 * entry.resumed: o nó atual estava aguardando e recebeu `input` (resposta) ou um disparo de temporizador.
 */
export async function execute(
  def: FlowDefinition,
  state: RunState,
  io: FlowIO,
  entry: { resumed: boolean; input: string | null; timer: boolean },
): Promise<ExecResult> {
  const steps: ExecResult['steps'] = []
  let nodeId = state.currentNodeId ?? startNode(def)?.id ?? null
  let resumed = entry.resumed
  let input = entry.input
  let timer = entry.timer

  for (let i = 0; i < MAX_STEPS; i++) {
    if (!nodeId) return { status: 'done', state: { ...state, currentNodeId: null, waitingFor: null }, steps }
    const node = def.nodes.find((n) => n.id === nodeId)
    if (!node) return { status: 'failed', state, steps, error: `Nó ${nodeId} não existe na versão publicada` }
    const type = nodeTypeMap.get(node.type)
    if (!type) return { status: 'failed', state, steps, error: `Tipo de nó desconhecido: ${node.type}` }

    let ctx!: NodeContext
    ctx = { node, state, io, input, resumed, timer, interpolate: makeInterpolate(() => ctx) }
    let r
    try {
      r = await type.run(ctx)
    } catch (err: any) {
      steps.push({ nodeId: node.id, type: node.type, handle: 'erro' })
      return { status: 'failed', state, steps, error: `${type.label}: ${err?.message ?? err}` }
    }
    resumed = false
    input = null
    timer = false

    if ('wait' in r) {
      steps.push({ nodeId: node.id, type: node.type, handle: null })
      return { status: 'waiting', state: { ...state, currentNodeId: node.id, waitingFor: r.wait }, steps }
    }
    if ('end' in r) {
      steps.push({ nodeId: node.id, type: node.type, handle: r.end })
      return { status: r.end, state: { ...state, currentNodeId: node.id, waitingFor: null }, steps }
    }
    steps.push({ nodeId: node.id, type: node.type, handle: r.next })
    state.retries = 0
    state.wakeToken = null
    nodeId = nextNodeId(def, node.id, r.next)
    state.currentNodeId = nodeId
    // Saída sem conexão = fim do fluxo
    if (!nodeId) return { status: 'done', state: { ...state, currentNodeId: null, waitingFor: null }, steps }
  }
  return { status: 'failed', state, steps, error: `O fluxo executou ${MAX_STEPS} etapas seguidas sem esperar o contato (possível laço infinito).` }
}
