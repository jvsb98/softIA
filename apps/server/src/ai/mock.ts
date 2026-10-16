/**
 * Provedor "Simulado": funciona sem chave de API e sem internet.
 * Usa regras simples para que fluxos, simulador e a passagem para humano possam ser
 * testados antes de cadastrar um provedor real. Não substitui um modelo de linguagem.
 */
import type { ChatRequest, ChatResult, ToolCallRecord } from './providers.js'

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

function lastUser(r: ChatRequest) {
  return [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
}

function triage(text: string) {
  const t = norm(text)
  const human = /(falar|conversar).{0,20}(pessoa|humano|atendente|alguem|especialista|consultor)|atendente|humano/.test(t)
  const sensitive = /(resgat|saque|sacar|reclama|procon|advogad|processo|golpe|fraude|cancelar.*investimento|devolu)/.test(t)
  const frustration = /(absurdo|ridiculo|pessimo|horrivel|ninguem responde|palhacada|nao aguento|!!!)/.test(t)
  const customer = /(minha conta|meus tokens|meu investimento na nimber|meu extrato|sou cliente|ja sou investidor da nimber|nao consigo (entrar|acessar))/.test(t)
  const optOut = /^(parar|sair|pare|nao quero mais|remover|descadastrar)\b/.test(t.trim())
  return {
    intent: human ? 'falar_com_humano' : sensitive ? 'assunto_sensivel' : customer ? 'suporte_cliente' : /\?|como|quanto|qual|o que|funciona/.test(t) ? 'duvida' : 'conversa',
    wants_human: human,
    sensitive,
    sensitive_topic: sensitive ? 'tema sensível' : null,
    frustration,
    existing_customer_account_issue: customer,
    opt_out: optOut,
    language_ok: true,
  }
}

function extractCriteria(text: string) {
  const t = norm(text)
  const out: Record<string, any> = {}
  const m = t.match(/(\d+[\d.,]*)\s*(mil|k|milhao|milhoes)?/)
  if (m) {
    let n = Number(m[1]!.replace(/\./g, '').replace(',', '.'))
    if (m[2] === 'mil' || m[2] === 'k') n *= 1000
    if (m[2]?.startsWith('milh')) n *= 1_000_000
    if (n >= 100) out.valor = n
  }
  if (/imove|imobiliario dire|apartament/.test(t) && !/fundo imobiliario|fii/.test(t)) out.experiencia = 'imoveis'
  else if (/\b(fiis?|fundos?|acoes|acao|bolsa)\b/.test(t)) out.experiencia = 'fundos_acoes'
  else if (/\b(cdbs?|tesouro|poupanca|renda fixa|lcis?|lcas?)\b/.test(t)) out.experiencia = 'renda_fixa'
  else if (/nunca invest|nao invisto|ainda nao invisto|primeira vez/.test(t)) out.experiencia = 'nenhuma'
  if (/agora|esse mes|este mes|hoje|imediat|ja quero/.test(t)) out.prazo = 'agora'
  else if (/proximos meses|ate o fim do ano|em breve|mes que vem/.test(t)) out.prazo = 'meses'
  else if (/pesquisando|so olhando|conhecendo|curiosidade/.test(t)) out.prazo = 'pesquisando'
  return out
}

function kbSnippet(system: string): string | null {
  const m = system.match(/<conhecimento>([\s\S]*?)<\/conhecimento>/)
  if (!m) return null
  const first = m[1]!.split(/\n### /).map((s) => s.trim()).find((s) => s.length > 40)
  if (!first) return null
  const body = first.replace(/^[^\n]*\n/, '').replace(/\s+/g, ' ').trim()
  const sentences = body.match(/[^.!?]+[.!?]/g) ?? [body]
  return sentences.slice(0, 2).join(' ').trim()
}

export async function mockChat(r: ChatRequest): Promise<ChatResult> {
  const text = lastUser(r)
  const toolCalls: ToolCallRecord[] = []
  const usage = { input: Math.ceil((r.system.length + text.length) / 4), output: 60 }

  if (r.mockHint === 'triage') return { text: JSON.stringify(triage(text)), toolCalls, usage }
  if (r.mockHint === 'guard') return { text: JSON.stringify({ ok: true, violations: [] }), toolCalls, usage }
  if (r.mockHint === 'summary') {
    const lines = r.messages.map((m) => m.content).join('\n').split('\n').filter(Boolean)
    return {
      text: JSON.stringify({
        resumo: `Contato conversou com o assistente (${lines.length} mensagens). Última fala: "${text.slice(0, 120)}".`,
        interesse: 'Ver histórico da conversa',
        pontos_de_atencao: [],
        sugestao_resposta: 'Olá! Aqui é do time da Nimber, vou dar continuidade ao seu atendimento. Como posso te ajudar?',
      }),
      toolCalls,
      usage,
    }
  }
  if (r.mockHint === 'classify') {
    const cats = (r.system.match(/CATEGORIAS: (.*)/)?.[1] ?? '').split('|').map((s) => s.trim()).filter(Boolean)
    const t = norm(text)
    const hit = cats.find((c) => norm(c).split(/\s+/).some((w) => w.length > 3 && t.includes(w))) ?? cats[cats.length - 1] ?? 'outro'
    return { text: JSON.stringify({ categoria: hit }), toolCalls, usage }
  }

  // Agente
  let next: string | null = null
  if (r.onTool && r.tools?.some((t) => t.name === 'registrar_criterios')) {
    const found = extractCriteria(text)
    const result = await r.onTool('registrar_criterios', { valores: found })
    toolCalls.push({ name: 'registrar_criterios', args: { valores: found }, result })
    next = result?.proxima_pergunta ?? null
  }
  const snippet = /\?|como|quanto|qual|o que|funciona|explica/.test(norm(text)) ? kbSnippet(r.system) : null
  const firstTurn = r.messages.filter((m) => m.role === 'assistant').length === 0
  const parts: string[] = []
  if (firstTurn) parts.push('Olá! Sou o assistente virtual da Nimber.')
  if (snippet) parts.push(snippet)
  else if (!firstTurn && !next) parts.push('Obrigado pelas informações! Posso te ajudar com mais alguma dúvida sobre a Nimber?')
  if (next) parts.push(next)
  else if (firstTurn && !snippet) parts.push('Como posso te ajudar hoje?')
  return { text: parts.join('\n\n'), toolCalls, usage }
}
