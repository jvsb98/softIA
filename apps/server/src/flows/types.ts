import type { AgentOutcome } from '../ai/agent.js'
import type { ChatMessage } from '../ai/providers.js'

export interface FlowNode {
  id: string
  type: string
  position?: { x: number; y: number }
  data: Record<string, any>
}
export interface FlowEdge {
  id: string
  source: string
  sourceHandle?: string | null
  target: string
}
export interface FlowDefinition {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

/** Entrada/saída do motor — implementada pelo atendimento real e pelo simulador. */
export interface FlowIO {
  sim: boolean
  contact: () => Promise<any>
  send: (text: string) => Promise<void>
  transfer: (sectorId: string | null, userId: string | null, reason: string, priority: number) => Promise<void>
  close: (reason: string) => Promise<void>
  addTags: (tagIds: string[]) => Promise<void>
  updateContact: (patch: Record<string, any>) => Promise<void>
  agentTurn: (agentId: string | null, extraInstructions: string) => Promise<AgentOutcome>
  aiJson: (system: string, user: string, hint: string) => Promise<any>
  isSectorOpen: (sectorId: string) => Promise<boolean>
  scheduleTimer: (ms: number, token: string) => Promise<void>
  runQuery?: (queryId: string, params: Record<string, any>) => Promise<{ rows: any[]; error?: string }>
  event: (type: string, data: Record<string, any>) => Promise<void>
  history: () => Promise<ChatMessage[]>
}

export interface RunState {
  vars: Record<string, any>
  currentNodeId: string | null
  waitingFor: 'reply' | 'timer' | null
  retries: number
  wakeToken: string | null
}

/** Resultado da execução de um nó. */
export type NodeResult =
  | { next: string } // handle de saída
  | { wait: 'reply' }
  | { wait: 'timer'; ms: number }
  | { end: 'done' | 'transferred' | 'closed' }

export interface NodeContext {
  node: FlowNode
  state: RunState
  io: FlowIO
  /** texto recebido quando o nó está sendo retomado após aguardar resposta */
  input: string | null
  /** true quando o nó está sendo retomado (após aguardar) */
  resumed: boolean
  /** retomado por temporizador */
  timer: boolean
  /** substitui {{variaveis}}; jsonEscape=true escapa os valores para uso dentro de JSON */
  interpolate: (s: string, jsonEscape?: boolean) => Promise<string>
}

export interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'sector' | 'user' | 'agent' | 'tags' | 'options' | 'rules' | 'fields' | 'categories' | 'query' | 'code' | 'keyvalue'
  help?: string
  placeholder?: string
  required?: boolean
  options?: { value: string; label: string }[]
  default?: any
}

export interface NodeType {
  type: string
  label: string
  description: string
  category: 'Mensagens' | 'Lógica' | 'Inteligência artificial' | 'Ações' | 'Integrações'
  advanced?: boolean
  icon: string
  /** saídas fixas; nós com saídas dinâmicas implementam dynamicOutputs */
  outputs: { id: string; label: string }[]
  dynamicOutputs?: (data: Record<string, any>) => { id: string; label: string }[]
  fields: FieldSpec[]
  /** variáveis que este nó define (para validação de {{variaveis}}) */
  defines?: (data: Record<string, any>) => string[]
  run: (ctx: NodeContext) => Promise<NodeResult>
}
