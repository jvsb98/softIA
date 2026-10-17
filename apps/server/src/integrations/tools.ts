/**
 * Liga as consultas cadastradas à IA (ferramentas do agente) e aos fluxos (nó "Consultar base").
 */
import { one, q } from '../lib/db.js'
import { registerAgentTools } from '../ai/agent.js'
import { registerNodeType } from '../flows/nodes.js'
import { executeSavedQuery, verifyIdentity, type ParamSpec } from './queries.js'

const toolName = (name: string) => `consulta_${name}`.slice(0, 60)

function paramsSchema(specs: ParamSpec[]) {
  const properties: Record<string, any> = {}
  for (const s of specs) {
    properties[s.name] = { type: s.type === 'number' ? 'number' : 'string', description: `${s.description ?? s.name}${s.type === 'cpf' ? ' (CPF, só números)' : ''}` }
  }
  return { type: 'object', properties, required: specs.filter((s) => s.required).map((s) => s.name) }
}

export function registerIntegrationTools() {
  // ------------------------------------------------------------ ferramentas da IA
  registerAgentTools(async ({ agent, conversation }) => {
    const allowed: string[] = agent?.allowed_query_ids ?? []
    if (!allowed.length) return { tools: [], handle: async () => undefined }
    const rows = await q<any>(`SELECT id, name, label, description, params, requires_verification FROM saved_queries WHERE enabled AND ai_enabled AND id = ANY($1)`, [allowed])
    const tools = rows.map((r) => ({
      name: toolName(r.name),
      description: `${r.label}: ${r.description}${r.requires_verification ? ' (exige verificação de identidade antes)' : ''}`,
      parameters: paramsSchema(r.params ?? []),
    }))
    const needsVerification = rows.some((r) => r.requires_verification)
    const verification = needsVerification ? await one<any>(`SELECT params FROM saved_queries WHERE is_verification AND enabled LIMIT 1`) : null
    if (verification) {
      tools.push({
        name: 'verificar_identidade',
        description:
          'Confirma que o contato é o titular da conta antes de consultar dados pessoais. Peça os dados ao contato (por exemplo CPF e e-mail cadastrados) e chame esta ferramenta. Nunca revele dados se a verificação falhar.',
        parameters: paramsSchema(verification.params ?? []),
      })
    }
    return {
      tools,
      handle: async (name, args) => {
        const convId = String(conversation.id).startsWith('sim-') ? null : conversation.id
        if (name === 'verificar_identidade') {
          if (!convId) return { verificado: true, instrucao: '(simulador) verificação simulada como bem-sucedida' }
          return verifyIdentity(convId, args ?? {})
        }
        const r = rows.find((x) => toolName(x.name) === name)
        if (!r) return undefined
        const res = await executeSavedQuery(r.id, args ?? {}, { conversationId: convId, actor: convId ? 'ai' : 'test' })
        if (res.error) return { erro: res.error }
        return {
          linhas: res.rows,
          total: res.rows.length,
          truncado: !!res.truncated,
          instrucao: res.rows.length ? 'Use somente estes dados, sem inventar nada além deles.' : 'Nenhum resultado. Diga isso ao contato e, se necessário, transfira.',
        }
      },
    }
  })

  // ------------------------------------------------------------ nó de fluxo
  registerNodeType({
    type: 'query',
    label: 'Consultar base de dados',
    description: 'Executa uma consulta cadastrada (somente leitura) e guarda o resultado em variáveis.',
    category: 'Integrações',
    icon: 'database',
    outputs: [
      { id: 'found', label: 'Encontrou' },
      { id: 'not_found', label: 'Não encontrou' },
      { id: 'error', label: 'Erro / precisa verificar' },
    ],
    fields: [
      { key: 'queryId', label: 'Consulta', type: 'query', required: true },
      { key: 'params', label: 'Parâmetros', type: 'keyvalue', help: 'Nome do parâmetro e valor (pode usar variáveis, ex.: {{cpf}}).' },
      { key: 'variable', label: 'Guardar resultado em', type: 'text', default: 'consulta' },
    ],
    defines: (d) => [String(d.variable || 'consulta')],
    run: async (ctx) => {
      const d = ctx.node.data
      const params: Record<string, any> = {}
      for (const kv of d.params ?? []) if (kv.key) params[kv.key] = await ctx.interpolate(String(kv.value ?? ''))
      if (!ctx.io.runQuery) return { next: 'error' }
      const r = await ctx.io.runQuery(String(d.queryId), params)
      const v = String(d.variable || 'consulta')
      ctx.state.vars[v] = r.rows.length === 1 ? r.rows[0] : r.rows
      ctx.state.vars[`${v}_total`] = r.rows.length
      if (r.error) {
        ctx.state.vars[`${v}_erro`] = r.error
        return { next: 'error' }
      }
      return { next: r.rows.length ? 'found' : 'not_found' }
    },
  })
}
