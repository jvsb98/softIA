/**
 * Validação antes de publicar: impede publicar um fluxo que deixaria conversas presas.
 */
import { nodeTypeMap, outputsOf } from './nodes.js'
import type { FlowDefinition } from './types.js'

export interface Issue {
  level: 'error' | 'warning'
  nodeId?: string
  message: string
}

const BUILTIN_ROOTS = new Set(['contato', 'vars', 'ia_resultado', 'ia_score', 'ia_motivo', 'ia_setor', 'resposta_http', 'codigo_erro'])

export function validateFlow(def: FlowDefinition, opts: { allowAdvanced: boolean }): Issue[] {
  const issues: Issue[] = []
  const nodes = def.nodes ?? []
  const edges = def.edges ?? []
  const starts = nodes.filter((n) => n.type === 'start')
  if (starts.length === 0) issues.push({ level: 'error', message: 'O fluxo precisa de um nó "Início".' })
  if (starts.length > 1) issues.push({ level: 'error', message: 'Existe mais de um nó "Início".' })

  const ids = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) issues.push({ level: 'error', message: 'Há uma ligação apontando para um nó que não existe.' })
  }

  // Alcançabilidade a partir do início
  const reach = new Set<string>()
  const stack = starts.map((s) => s.id)
  while (stack.length) {
    const id = stack.pop()!
    if (reach.has(id)) continue
    reach.add(id)
    for (const e of edges) if (e.source === id) stack.push(e.target)
  }

  // Variáveis definidas em qualquer lugar do fluxo
  const defined = new Set<string>()
  for (const n of nodes) for (const v of nodeTypeMap.get(n.type)?.defines?.(n.data ?? {}) ?? []) defined.add(v)

  for (const n of nodes) {
    const t = nodeTypeMap.get(n.type)
    if (!t) {
      issues.push({ level: 'error', nodeId: n.id, message: `Tipo de nó desconhecido: ${n.type}` })
      continue
    }
    const label = n.data?.title || t.label
    if (!reach.has(n.id)) issues.push({ level: 'warning', nodeId: n.id, message: `"${label}" não está ligado ao fluxo (nunca será executado).` })
    if (t.advanced && !opts.allowAdvanced) issues.push({ level: 'error', nodeId: n.id, message: `"${label}" é um nó avançado: só usuários com permissão de nós avançados podem publicar.` })
    for (const f of t.fields) {
      const v = n.data?.[f.key]
      if (f.required && (v === undefined || v === null || String(v).trim() === '')) issues.push({ level: 'error', nodeId: n.id, message: `"${label}": preencha "${f.label}".` })
    }
    if (n.type === 'menu' && !(n.data?.options ?? []).length) issues.push({ level: 'error', nodeId: n.id, message: `"${label}": cadastre pelo menos uma opção.` })
    if (n.type === 'condition' && !(n.data?.rules ?? []).length) issues.push({ level: 'error', nodeId: n.id, message: `"${label}": cadastre pelo menos uma regra.` })
    if (n.type === 'ai_classify' && !(n.data?.categories ?? []).length) issues.push({ level: 'error', nodeId: n.id, message: `"${label}": cadastre as categorias.` })
    if ((n.type === 'question' || n.type === 'set_variable') && n.data?.variable && !/^[a-z_][a-z0-9_]*$/i.test(String(n.data.variable)))
      issues.push({ level: 'error', nodeId: n.id, message: `"${label}": nome de variável inválido (use letras, números e _).` })

    // Saídas sem ligação (avisos: saída solta = fim do fluxo)
    const outs = outputsOf(n.type, n.data ?? {})
    for (const o of outs) {
      const linked = edges.some((e) => e.source === n.id && (e.sourceHandle ?? 'next') === o.id)
      if (!linked && reach.has(n.id)) {
        const important = ['next', 'qualified', 'handoff', 'ok'].includes(o.id) || o.id.startsWith('opt_') || o.id.startsWith('rule_') || o.id.startsWith('cat_')
        if (important) issues.push({ level: 'warning', nodeId: n.id, message: `"${label}": a saída "${o.label}" não está ligada — o fluxo termina ali.` })
      }
    }

    // Variáveis usadas e não definidas
    const text = JSON.stringify(n.data ?? {})
    for (const m of text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      const root = m[1]!.split('.')[0]!
      if (!BUILTIN_ROOTS.has(root) && !defined.has(root)) issues.push({ level: 'warning', nodeId: n.id, message: `"${label}": a variável {{${m[1]}}} não é definida em nenhum nó.` })
    }
  }
  return issues
}
