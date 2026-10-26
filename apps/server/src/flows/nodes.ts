/**
 * Catálogo de nós do construtor de fluxos. O front-end recebe esta lista via API
 * (/api/flows/node-types) e monta a paleta e os formulários a partir dela.
 */
import vm from 'node:vm'
import type { NodeContext, NodeResult, NodeType } from './types.js'
import { safeFetch } from '../lib/net-guard.js'

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

function validate(kind: string, input: string): { ok: boolean; value: any } {
  const t = input.trim()
  switch (kind) {
    case 'number': {
      const m = t.replace(/\s/g, '').match(/-?\d+[\d.,]*/)
      if (!m) return { ok: false, value: null }
      let s = m[0]
      if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
      else s = s.replace(/[.,]/g, '')
      let n = Number(s)
      if (/\bmil\b/i.test(t)) n *= 1000
      return { ok: Number.isFinite(n), value: n }
    }
    case 'email': {
      const m = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
      return { ok: !!m, value: m?.[0]?.toLowerCase() ?? null }
    }
    case 'cpf': {
      const d = t.replace(/\D/g, '')
      if (d.length !== 11 || /^(\d)\1+$/.test(d)) return { ok: false, value: null }
      const calc = (len: number) => {
        let s = 0
        for (let i = 0; i < len; i++) s += Number(d[i]) * (len + 1 - i)
        const r = (s * 10) % 11
        return r === 10 ? 0 : r
      }
      return { ok: calc(9) === Number(d[9]) && calc(10) === Number(d[10]), value: d }
    }
    case 'phone': {
      const d = t.replace(/\D/g, '')
      return { ok: d.length >= 10 && d.length <= 13, value: d }
    }
    case 'yesno': {
      const n = norm(t)
      if (/^(s|sim|claro|isso|pode|ok|quero|positivo|aham|1)\b/.test(n)) return { ok: true, value: true }
      if (/^(n|nao|não|negativo|agora nao|2)\b/.test(n)) return { ok: true, value: false }
      return { ok: false, value: null }
    }
    case 'any':
      return { ok: t.length > 0, value: t }
    default:
      return { ok: t.length > 0, value: t }
  }
}

const VALIDATIONS = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'email', label: 'E-mail' },
  { value: 'cpf', label: 'CPF (com dígito verificador)' },
  { value: 'phone', label: 'Telefone' },
  { value: 'yesno', label: 'Sim ou não' },
  { value: 'any', label: 'Qualquer resposta' },
]

/** Pergunta com espera de resposta, validação, novas tentativas e tempo limite. */
async function ask(ctx: NodeContext, opts: { text: string; onAnswer: (input: string) => Promise<NodeResult | null> }): Promise<NodeResult> {
  const d = ctx.node.data
  if (ctx.timer) return { next: 'timeout' }
  if (!ctx.resumed) {
    await ctx.io.send(await ctx.interpolate(opts.text))
    ctx.state.retries = 0
    if (d.timeoutMinutes > 0) {
      ctx.state.wakeToken = `${ctx.node.id}:${Date.now()}`
      await ctx.io.scheduleTimer(d.timeoutMinutes * 60_000, ctx.state.wakeToken)
    }
    return { wait: 'reply' }
  }
  const r = await opts.onAnswer(ctx.input ?? '')
  if (r) return r
  ctx.state.retries++
  if (ctx.state.retries >= Math.max(1, Number(d.maxRetries ?? 2))) return { next: 'invalid' }
  await ctx.io.send(await ctx.interpolate(d.retryMessage || 'Não entendi a sua resposta. Pode tentar de novo?'))
  return { wait: 'reply' }
}

function compare(a: any, op: string, b: any): boolean {
  const as = a == null ? '' : String(a)
  const bs = b == null ? '' : String(b)
  switch (op) {
    case 'equals':
      return norm(as) === norm(bs)
    case 'not_equals':
      return norm(as) !== norm(bs)
    case 'contains':
      return norm(as).includes(norm(bs))
    case 'not_contains':
      return !norm(as).includes(norm(bs))
    case 'gt':
      return Number(a) > Number(b)
    case 'gte':
      return Number(a) >= Number(b)
    case 'lt':
      return Number(a) < Number(b)
    case 'lte':
      return Number(a) <= Number(b)
    case 'exists':
      return a !== undefined && a !== null && as !== ''
    case 'not_exists':
      return a === undefined || a === null || as === ''
    case 'is_true':
      return a === true || as === 'true'
    case 'is_false':
      return a === false || as === 'false' || as === ''
    case 'regex':
      try {
        return new RegExp(bs, 'i').test(as)
      } catch {
        return false
      }
    default:
      return false
  }
}

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

export const NODE_TYPES: NodeType[] = [
  // ------------------------------------------------------------ início
  {
    type: 'start',
    label: 'Início',
    description: 'Ponto de entrada: a primeira mensagem do contato nesta conversa.',
    category: 'Mensagens',
    icon: 'play',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [],
    run: async () => ({ next: 'next' }),
  },
  // ------------------------------------------------------------ mensagens
  {
    type: 'message',
    label: 'Enviar mensagem',
    description: 'Envia um texto. Use {{contato.primeiro_nome}} e outras variáveis.',
    category: 'Mensagens',
    icon: 'message-square',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [{ key: 'text', label: 'Mensagem', type: 'textarea', required: true, placeholder: 'Olá, {{contato.primeiro_nome}}! Tudo bem?' }],
    run: async (ctx) => {
      await ctx.io.send(await ctx.interpolate(String(ctx.node.data.text ?? '')))
      return { next: 'next' }
    },
  },
  {
    type: 'question',
    label: 'Fazer pergunta',
    description: 'Pergunta, espera a resposta, valida e guarda numa variável.',
    category: 'Mensagens',
    icon: 'help-circle',
    outputs: [
      { id: 'next', label: 'Respondeu' },
      { id: 'invalid', label: 'Resposta inválida' },
      { id: 'timeout', label: 'Sem resposta' },
    ],
    fields: [
      { key: 'text', label: 'Pergunta', type: 'textarea', required: true },
      { key: 'variable', label: 'Guardar resposta em', type: 'text', required: true, placeholder: 'email', help: 'Nome da variável (letras, números e _).' },
      { key: 'validation', label: 'Tipo de resposta', type: 'select', options: VALIDATIONS, default: 'text' },
      { key: 'retryMessage', label: 'Mensagem se a resposta for inválida', type: 'text', placeholder: 'Não entendi. Pode tentar de novo?' },
      { key: 'maxRetries', label: 'Tentativas', type: 'number', default: 2 },
      { key: 'timeoutMinutes', label: 'Tempo limite (minutos, 0 = sem limite)', type: 'number', default: 0 },
    ],
    defines: (d) => (d.variable ? [String(d.variable)] : []),
    run: (ctx) =>
      ask(ctx, {
        text: String(ctx.node.data.text ?? ''),
        onAnswer: async (input) => {
          const v = validate(ctx.node.data.validation ?? 'text', input)
          if (!v.ok) return null
          ctx.state.vars[String(ctx.node.data.variable)] = v.value
          return { next: 'next' }
        },
      }),
  },
  {
    type: 'menu',
    label: 'Menu de opções',
    description: 'Mostra opções numeradas e segue pelo caminho escolhido (por número ou palavra).',
    category: 'Mensagens',
    icon: 'list',
    outputs: [
      { id: 'invalid', label: 'Não reconhecida' },
      { id: 'timeout', label: 'Sem resposta' },
    ],
    dynamicOutputs: (d) => (d.options ?? []).map((o: any, i: number) => ({ id: `opt_${i}`, label: o.label || `Opção ${i + 1}` })),
    fields: [
      { key: 'text', label: 'Texto antes das opções', type: 'textarea', required: true, placeholder: 'Como posso te ajudar?' },
      { key: 'options', label: 'Opções', type: 'options', help: 'Cada opção vira uma saída. Palavras-chave ajudam a reconhecer respostas escritas.' },
      { key: 'variable', label: 'Guardar escolha em (opcional)', type: 'text', placeholder: 'assunto' },
      { key: 'retryMessage', label: 'Mensagem se não reconhecer', type: 'text', placeholder: 'Responda com o número da opção, por favor.' },
      { key: 'maxRetries', label: 'Tentativas', type: 'number', default: 2 },
      { key: 'timeoutMinutes', label: 'Tempo limite (minutos, 0 = sem limite)', type: 'number', default: 0 },
    ],
    defines: (d) => (d.variable ? [String(d.variable)] : []),
    run: (ctx) => {
      const opts: { label: string; keywords?: string }[] = ctx.node.data.options ?? []
      const text = `${ctx.node.data.text ?? ''}\n\n${opts.map((o, i) => `*${i + 1}.* ${o.label}`).join('\n')}`
      return ask(ctx, {
        text,
        onAnswer: async (input) => {
          const n = norm(input)
          const num = n.match(/^\s*(\d{1,2})\b/)
          let idx = num ? Number(num[1]) - 1 : -1
          if (idx < 0 || idx >= opts.length) {
            idx = opts.findIndex((o) => {
              const words = [o.label, ...(o.keywords ?? '').split(',')].map(norm).filter((w) => w.length >= 3)
              return words.some((w) => n.includes(w))
            })
          }
          if (idx < 0 || idx >= opts.length) return null
          if (ctx.node.data.variable) ctx.state.vars[String(ctx.node.data.variable)] = opts[idx]!.label
          return { next: `opt_${idx}` }
        },
      })
    },
  },
  // ------------------------------------------------------------ lógica
  {
    type: 'condition',
    label: 'Condição',
    description: 'Segue pelo primeiro caminho cuja regra for verdadeira.',
    category: 'Lógica',
    icon: 'git-branch',
    outputs: [{ id: 'else', label: 'Senão' }],
    dynamicOutputs: (d) => (d.rules ?? []).map((r: any, i: number) => ({ id: `rule_${i}`, label: r.label || `Regra ${i + 1}` })),
    fields: [{ key: 'rules', label: 'Regras', type: 'rules', help: 'Variável, operador e valor. Ex.: contato.score ≥ 22.' }],
    run: async (ctx) => {
      const rules: { variable: string; op: string; value: string }[] = ctx.node.data.rules ?? []
      const scope = await scopeFor(ctx)
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i]!
        const value = r.value?.includes('{{') ? await ctx.interpolate(r.value) : r.value
        if (compare(getPath(scope, r.variable), r.op, value)) return { next: `rule_${i}` }
      }
      return { next: 'else' }
    },
  },
  {
    type: 'set_variable',
    label: 'Definir variável',
    description: 'Guarda um valor (pode usar outras variáveis).',
    category: 'Lógica',
    icon: 'variable',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [
      { key: 'variable', label: 'Variável', type: 'text', required: true },
      { key: 'value', label: 'Valor', type: 'text', placeholder: '{{contato.nome}}' },
    ],
    defines: (d) => (d.variable ? [String(d.variable)] : []),
    run: async (ctx) => {
      ctx.state.vars[String(ctx.node.data.variable)] = await ctx.interpolate(String(ctx.node.data.value ?? ''))
      return { next: 'next' }
    },
  },
  {
    type: 'business_hours',
    label: 'Horário de atendimento',
    description: 'Verifica se o setor está no horário (considera feriados).',
    category: 'Lógica',
    icon: 'clock',
    outputs: [
      { id: 'open', label: 'Dentro do horário' },
      { id: 'closed', label: 'Fora do horário' },
    ],
    fields: [{ key: 'sectorId', label: 'Setor', type: 'sector', required: true }],
    run: async (ctx) => ({ next: (await ctx.io.isSectorOpen(String(ctx.node.data.sectorId))) ? 'open' : 'closed' }),
  },
  {
    type: 'wait',
    label: 'Aguardar',
    description: 'Pausa o fluxo por alguns minutos (ex.: antes de um lembrete).',
    category: 'Lógica',
    icon: 'hourglass',
    outputs: [{ id: 'next', label: 'Depois da espera' }],
    fields: [{ key: 'minutes', label: 'Minutos', type: 'number', default: 5 }],
    run: async (ctx) => {
      if (ctx.timer) return { next: 'next' }
      if (ctx.resumed) return { wait: 'timer', ms: 0 } // mensagens durante a espera não interrompem
      const ms = Math.max(1, Number(ctx.node.data.minutes ?? 5)) * 60_000
      ctx.state.wakeToken = `${ctx.node.id}:${Date.now()}`
      await ctx.io.scheduleTimer(ms, ctx.state.wakeToken)
      return { wait: 'timer', ms }
    },
  },
  // ------------------------------------------------------------ IA
  {
    type: 'ai_agent',
    label: 'Agente de IA',
    description: 'A IA conversa (base de conhecimento + qualificação) até qualificar, transferir ou desqualificar.',
    category: 'Inteligência artificial',
    icon: 'bot',
    outputs: [
      { id: 'qualified', label: 'Qualificado' },
      { id: 'handoff', label: 'Pediu humano / transferência' },
      { id: 'disqualified', label: 'Desqualificado' },
      { id: 'opt_out', label: 'Não quer mensagens' },
      { id: 'error', label: 'IA indisponível' },
    ],
    fields: [
      { key: 'agentId', label: 'Agente', type: 'agent', help: 'Vazio = agente padrão.' },
      { key: 'instructions', label: 'Objetivo desta etapa (opcional)', type: 'textarea', placeholder: 'Foque em entender o interesse no Hive SP.' },
      { key: 'greeting', label: 'Mensagem ao entrar (opcional)', type: 'textarea' },
    ],
    run: async (ctx) => {
      if (!ctx.resumed && ctx.node.data.greeting) {
        await ctx.io.send(await ctx.interpolate(String(ctx.node.data.greeting)))
        return { wait: 'reply' }
      }
      const outcome = await ctx.io.agentTurn(ctx.node.data.agentId || null, String(ctx.node.data.instructions ?? ''))
      ctx.state.vars.ia_resultado = outcome.kind
      if ('text' in outcome && outcome.text) await ctx.io.send(outcome.text)
      switch (outcome.kind) {
        case 'replied':
          return { wait: 'reply' }
        case 'qualified':
          ctx.state.vars.ia_score = outcome.score
          return { next: 'qualified' }
        case 'handoff':
          ctx.state.vars.ia_motivo = outcome.reason
          ctx.state.vars.ia_setor = outcome.sectorId
          return { next: 'handoff' }
        case 'disqualified':
          ctx.state.vars.ia_motivo = outcome.reason
          return { next: 'disqualified' }
        case 'opt_out':
          return { next: 'opt_out' }
        default:
          ctx.state.vars.ia_motivo = (outcome as any).reason
          return { next: 'error' }
      }
    },
  },
  {
    type: 'ai_classify',
    label: 'Classificar intenção (IA)',
    description: 'A IA lê a última mensagem e escolhe uma categoria.',
    category: 'Inteligência artificial',
    icon: 'tags',
    outputs: [{ id: 'other', label: 'Outra' }],
    dynamicOutputs: (d) => (d.categories ?? []).map((c: any, i: number) => ({ id: `cat_${i}`, label: c.name || `Categoria ${i + 1}` })),
    fields: [
      { key: 'categories', label: 'Categorias', type: 'categories', help: 'Nome e descrição de cada categoria.' },
      { key: 'variable', label: 'Guardar categoria em (opcional)', type: 'text', placeholder: 'intencao' },
    ],
    defines: (d) => (d.variable ? [String(d.variable)] : []),
    run: async (ctx) => {
      const cats: { name: string; description?: string }[] = ctx.node.data.categories ?? []
      const history = await ctx.io.history()
      const last = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
      const system = `Classifique a mensagem de um contato em UMA das categorias.\nCATEGORIAS: ${cats.map((c) => c.name).join(' | ')}\n${cats.map((c) => `- ${c.name}: ${c.description ?? ''}`).join('\n')}\nResponda SOMENTE com JSON: {"categoria": "<nome exato ou outra>"}`
      const j = await ctx.io.aiJson(system, last, 'classify').catch(() => null)
      const idx = cats.findIndex((c) => norm(c.name) === norm(String(j?.categoria ?? '')))
      if (ctx.node.data.variable) ctx.state.vars[String(ctx.node.data.variable)] = idx >= 0 ? cats[idx]!.name : 'outra'
      return { next: idx >= 0 ? `cat_${idx}` : 'other' }
    },
  },
  {
    type: 'ai_extract',
    label: 'Extrair dados (IA)',
    description: 'A IA lê a conversa e preenche variáveis (ex.: cidade, interesse).',
    category: 'Inteligência artificial',
    icon: 'scan-text',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [{ key: 'fields', label: 'Campos', type: 'fields', help: 'Nome da variável e o que extrair.' }],
    defines: (d) => (d.fields ?? []).map((f: any) => String(f.name)).filter(Boolean),
    run: async (ctx) => {
      const fields: { name: string; description: string }[] = ctx.node.data.fields ?? []
      const history = await ctx.io.history()
      const transcript = history.map((m) => `${m.role === 'user' ? 'Contato' : 'Empresa'}: ${m.content}`).join('\n')
      const system = `Extraia da conversa os campos abaixo. Use null quando não houver informação clara.\n${fields.map((f) => `- ${f.name}: ${f.description}`).join('\n')}\nResponda SOMENTE com JSON com essas chaves.`
      const j = (await ctx.io.aiJson(system, transcript, 'extract').catch(() => null)) ?? {}
      for (const f of fields) if (j[f.name] !== undefined && j[f.name] !== null) ctx.state.vars[f.name] = j[f.name]
      return { next: 'next' }
    },
  },
  // ------------------------------------------------------------ ações
  {
    type: 'transfer',
    label: 'Transferir para humano',
    description: 'Coloca a conversa na fila de um setor (ou de uma pessoa). Encerra o fluxo.',
    category: 'Ações',
    icon: 'user-round-check',
    outputs: [],
    fields: [
      { key: 'sectorId', label: 'Setor', type: 'sector', help: 'Vazio = setor sugerido pela IA ou o setor de entrada da conexão.' },
      { key: 'userId', label: 'Atendente (opcional)', type: 'user' },
      { key: 'reason', label: 'Motivo (aparece para o atendente)', type: 'text', placeholder: '{{ia_motivo}}' },
      { key: 'message', label: 'Mensagem ao contato (opcional)', type: 'textarea', placeholder: 'Vou te passar para um especialista. Só um instante!' },
      {
        key: 'priority',
        label: 'Prioridade',
        type: 'select',
        options: [
          { value: '0', label: 'Normal' },
          { value: '1', label: 'Alta' },
          { value: '2', label: 'Urgente' },
        ],
        default: '0',
      },
    ],
    run: async (ctx) => {
      const d = ctx.node.data
      if (d.message) await ctx.io.send(await ctx.interpolate(String(d.message)))
      const reason = (await ctx.interpolate(String(d.reason || 'Transferido pelo fluxo'))) || 'Transferido pelo fluxo'
      await ctx.io.transfer(d.sectorId || ctx.state.vars.ia_setor || null, d.userId || null, reason, Number(d.priority ?? 0))
      return { end: 'transferred' }
    },
  },
  {
    type: 'tag',
    label: 'Adicionar etiqueta',
    description: 'Marca o contato com etiquetas (ex.: origem da campanha).',
    category: 'Ações',
    icon: 'tag',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [{ key: 'tagIds', label: 'Etiquetas', type: 'tags' }],
    run: async (ctx) => {
      await ctx.io.addTags(ctx.node.data.tagIds ?? [])
      return { next: 'next' }
    },
  },
  {
    type: 'update_contact',
    label: 'Atualizar contato',
    description: 'Grava dados no cadastro do contato a partir das variáveis.',
    category: 'Ações',
    icon: 'user-pen',
    outputs: [{ id: 'next', label: 'Em seguida' }],
    fields: [
      { key: 'name', label: 'Nome', type: 'text', placeholder: '{{nome}}' },
      { key: 'email', label: 'E-mail', type: 'text', placeholder: '{{email}}' },
      { key: 'origin', label: 'Origem', type: 'text', placeholder: 'Campanha Hive SP' },
      {
        key: 'leadStatus',
        label: 'Status do lead',
        type: 'select',
        options: [
          { value: '', label: 'Não alterar' },
          { value: 'novo', label: 'Novo' },
          { value: 'em_qualificacao', label: 'Em qualificação' },
          { value: 'qualificado', label: 'Qualificado' },
          { value: 'desqualificado', label: 'Desqualificado' },
          { value: 'cliente', label: 'Cliente' },
        ],
      },
      { key: 'custom', label: 'Campos personalizados', type: 'keyvalue', help: 'Chave e valor (pode usar variáveis).' },
    ],
    run: async (ctx) => {
      const d = ctx.node.data
      const patch: Record<string, any> = {}
      for (const k of ['name', 'email', 'origin']) if (d[k]) patch[k] = await ctx.interpolate(String(d[k]))
      if (d.leadStatus) patch.leadStatus = d.leadStatus
      if (Array.isArray(d.custom) && d.custom.length) {
        patch.custom = {}
        for (const kv of d.custom) if (kv.key) patch.custom[kv.key] = await ctx.interpolate(String(kv.value ?? ''))
      }
      await ctx.io.updateContact(patch)
      return { next: 'next' }
    },
  },
  {
    type: 'close',
    label: 'Encerrar conversa',
    description: 'Envia uma despedida (opcional) e encerra a conversa.',
    category: 'Ações',
    icon: 'circle-check',
    outputs: [],
    fields: [
      { key: 'message', label: 'Mensagem de despedida', type: 'textarea' },
      { key: 'reason', label: 'Motivo', type: 'text', default: 'Encerrada pelo fluxo' },
    ],
    run: async (ctx) => {
      if (ctx.node.data.message) await ctx.io.send(await ctx.interpolate(String(ctx.node.data.message)))
      await ctx.io.close(String(ctx.node.data.reason || 'Encerrada pelo fluxo'))
      return { end: 'closed' }
    },
  },
  {
    type: 'end',
    label: 'Fim do fluxo',
    description: 'Termina o fluxo. A conversa segue com o agente de IA padrão (ou vai para o setor de entrada, se a IA estiver desligada).',
    category: 'Ações',
    icon: 'flag',
    outputs: [],
    fields: [],
    run: async () => ({ end: 'done' }),
  },
  // ------------------------------------------------------------ integrações (avançado)
  {
    type: 'http',
    label: 'Requisição HTTP',
    description: 'Chama uma API externa (ex.: n8n, CRM) e guarda a resposta.',
    category: 'Integrações',
    advanced: true,
    icon: 'globe',
    outputs: [
      { id: 'ok', label: 'Sucesso' },
      { id: 'error', label: 'Erro' },
    ],
    fields: [
      {
        key: 'method',
        label: 'Método',
        type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
        default: 'POST',
      },
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://n8n.suaempresa.com.br/webhook/lead' },
      { key: 'headers', label: 'Cabeçalhos', type: 'keyvalue' },
      { key: 'body', label: 'Corpo (JSON, aceita variáveis)', type: 'code', placeholder: '{"telefone": "{{contato.telefone}}", "score": "{{contato.score}}"}' },
      { key: 'variable', label: 'Guardar resposta em', type: 'text', default: 'resposta_http' },
      { key: 'timeoutMs', label: 'Tempo limite (ms)', type: 'number', default: 10000 },
    ],
    defines: (d) => [String(d.variable || 'resposta_http')],
    run: async (ctx) => {
      const d = ctx.node.data
      const url = await ctx.interpolate(String(d.url ?? ''))
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const kv of d.headers ?? []) if (kv.key) headers[kv.key] = await ctx.interpolate(String(kv.value ?? ''))
      const method = String(d.method ?? 'POST')
      const body = method === 'GET' || method === 'DELETE' ? undefined : await ctx.interpolate(String(d.body ?? ''), true)
      if (ctx.io.sim && !url.startsWith('http')) return { next: 'error' }
      try {
        const res = await safeFetch(url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(Number(d.timeoutMs ?? 10000)) })
        const text = await res.text()
        let data: any = text
        try {
          data = JSON.parse(text)
        } catch {
          /* texto */
        }
        ctx.state.vars[String(d.variable || 'resposta_http')] = data
        ctx.state.vars[`${d.variable || 'resposta_http'}_status`] = res.status
        return { next: res.ok ? 'ok' : 'error' }
      } catch (err: any) {
        ctx.state.vars[`${d.variable || 'resposta_http'}_erro`] = String(err?.message ?? err)
        return { next: 'error' }
      }
    },
  },
  {
    type: 'code',
    label: 'Código (JavaScript)',
    description: 'Transforma variáveis com um trecho de JavaScript isolado (sem rede, 1s de limite). Retorne um objeto.',
    category: 'Integrações',
    advanced: true,
    icon: 'code',
    outputs: [
      { id: 'ok', label: 'Sucesso' },
      { id: 'error', label: 'Erro' },
    ],
    fields: [
      {
        key: 'code',
        label: 'Código',
        type: 'code',
        default: '// "vars" e "contato" estão disponíveis\nreturn { faixa: vars.valor >= 50000 ? "alta" : "baixa" }',
      },
    ],
    run: async (ctx) => {
      try {
        const contact = await ctx.io.contact()
        const sandbox = { vars: JSON.parse(JSON.stringify(ctx.state.vars)), contato: JSON.parse(JSON.stringify(contact ?? {})), result: undefined as any }
        vm.runInNewContext(`result = (function(){ ${String(ctx.node.data.code ?? '')} \n})()`, sandbox, { timeout: 1000 })
        if (sandbox.result && typeof sandbox.result === 'object') Object.assign(ctx.state.vars, sandbox.result)
        return { next: 'ok' }
      } catch (err: any) {
        ctx.state.vars.codigo_erro = String(err?.message ?? err)
        return { next: 'error' }
      }
    },
  },
]

export const nodeTypeMap = new Map(NODE_TYPES.map((n) => [n.type, n]))

/** Registro de nós extras (ex.: consultas a bases externas, na fase 4). */
export function registerNodeType(n: NodeType) {
  if (!nodeTypeMap.has(n.type)) NODE_TYPES.push(n)
  nodeTypeMap.set(n.type, n)
}

export function outputsOf(type: string, data: Record<string, any>) {
  const def = nodeTypeMap.get(type)
  if (!def) return []
  return [...(def.dynamicOutputs?.(data) ?? []), ...def.outputs]
}

/** Escopo das variáveis: {{contato.*}}, {{var}} e {{vars.var}}. */
export async function scopeFor(ctx: NodeContext) {
  const c = (await ctx.io.contact()) ?? {}
  const name = c.name || c.push_name || ''
  return {
    ...ctx.state.vars,
    vars: ctx.state.vars,
    contato: {
      nome: name,
      primeiro_nome: name.split(' ')[0] ?? '',
      telefone: c.phone ?? '',
      email: c.email ?? '',
      score: c.score ?? null,
      status: c.lead_status ?? '',
      cliente: !!c.is_customer,
      origem: c.origin ?? '',
      ...(c.lead_profile ?? {}),
      campos: c.custom ?? {},
    },
  }
}
