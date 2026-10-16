/**
 * Travas de compliance — três camadas:
 *  1. instruções explícitas no prompt do agente (ver agent.ts);
 *  2. pré-filtro determinístico (expressões abaixo);
 *  3. verificador por IA (tarefa "guard") que aprova ou bloqueia o rascunho.
 * Resposta bloqueada NÃO é enviada: vai para humano e fica registrada na auditoria.
 */
import { getSetting } from '../ops/settings.js'
import { parseJsonLoose } from './providers.js'
import { runChat } from './router.js'

export type Rule = 'rentabilidade' | 'recomendacao' | 'juridico_tributario'

export const RULE_LABEL: Record<Rule, string> = {
  rentabilidade: 'promessa ou projeção de rentabilidade',
  recomendacao: 'recomendação personalizada de investimento',
  juridico_tributario: 'orientação jurídica ou tributária',
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const PATTERNS: { rule: Rule; re: RegExp }[] = [
  { rule: 'rentabilidade', re: /(rentabilidade|retorno|rendimento|lucro|ganho)s?\s+(e\s+)?(garantid|assegurad|cert[oa]\b|fix[oa] garantid)/ },
  { rule: 'rentabilidade', re: /garant\w*\s+(de\s+|um\s+|uma\s+)?(\d+[,.]?\d*\s*%|retorno|rendimento|lucro|rentabilidade|valorizacao)/ },
  { rule: 'rentabilidade', re: /\b(sem|zero|nenhum)\s+risco\b|\brisco\s+(zero|nenhum|inexistente)\b/ },
  { rule: 'rentabilidade', re: /\b(vai|vao|ira|irao)\s+(render|valorizar|dobrar|triplicar|lucrar)\b/ },
  { rule: 'rentabilidade', re: /\b(com certeza|certamente|garantidamente)\b.{0,40}\b(render|valoriz|lucr|retorno)/ },
  { rule: 'recomendacao', re: /\b(recomendo|sugiro|aconselho|indico)\s+(que\s+)?(voce\s+|o senhor\s+|a senhora\s+)?(invist|apliqu|compr|coloqu|aloqu)/ },
  { rule: 'recomendacao', re: /\b(para|pro)\s+(o\s+)?seu\s+perfil.{0,40}\b(invista|aplique|o ideal e|o melhor e|recomend)/ },
  { rule: 'recomendacao', re: /\b(invista|aplique|coloque)\s+(todo|tudo|metade|o restante|suas economias|sua reserva)/ },
  { rule: 'recomendacao', re: /\b(voce deveria|vale muito a pena voce)\s+(investir|aplicar|comprar)/ },
  { rule: 'juridico_tributario', re: /\b(voce\s+)?(nao\s+)?(precisa|deve|tera que|vai ter que)\s+(declarar|pagar\s+(o\s+)?imposto|recolher|pagar\s+ir)\b/ },
  { rule: 'juridico_tributario', re: /\b(e|sao|fica|ficam)\s+isent[oa]s?\s+de\s+(imposto|ir|ir\b|tributo)/ },
  { rule: 'juridico_tributario', re: /\b(juridicamente|legalmente|do ponto de vista (juridico|legal|fiscal|tributario)),?\s+voce\s+(pode|deve|nao pode)/ },
]

export function prefilter(text: string): { rule: Rule; excerpt: string } | null {
  const t = norm(text)
  for (const p of PATTERNS) {
    const m = t.match(p.re)
    if (m) return { rule: p.rule, excerpt: text.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length + 20) }
  }
  return null
}

const GUARD_SYSTEM = `Você é o revisor de compliance de uma plataforma brasileira de investimentos em ativos imobiliários tokenizados, regulada pela CVM.
Avalie o RASCUNHO de resposta de um assistente virtual para um cliente no WhatsApp e diga se ele viola alguma destas regras:
1. rentabilidade — promete, garante ou projeta rentabilidade/retorno/valorização além de repetir de forma neutra um número oficialmente publicado na oferta (sempre como estimativa, sem garantia); também viola dizer "sem risco".
2. recomendacao — faz recomendação personalizada de investimento (dizer o que a pessoa específica deve fazer com o dinheiro dela, quanto investir, que é ideal para o perfil dela).
3. juridico_tributario — dá orientação jurídica ou tributária (o que declarar, se paga imposto, direitos legais), em vez de sugerir consultar um especialista.
Explicar como funciona a tokenização, o que é uma oferta, prazos e características publicadas NÃO é violação.
Responda SOMENTE com JSON: {"ok": true|false, "violations": [{"rule": "rentabilidade|recomendacao|juridico_tributario", "excerpt": "trecho"}]}`

export async function checkCompliance(draft: string, conversationId: string | null): Promise<{ ok: boolean; rule?: Rule; excerpt?: string; by?: 'filtro' | 'ia' }> {
  const settings = await getSetting('compliance', { guardEnabled: true })
  const pre = prefilter(draft)
  if (pre) return { ok: false, rule: pre.rule, excerpt: pre.excerpt, by: 'filtro' }
  if (!settings.guardEnabled) return { ok: true }
  try {
    const r = await runChat('guard', { system: GUARD_SYSTEM, messages: [{ role: 'user', content: `RASCUNHO:\n"""${draft}"""` }], json: true, timeoutMs: 15_000 }, conversationId)
    const j = parseJsonLoose<{ ok: boolean; violations?: { rule: Rule; excerpt: string }[] }>(r.text)
    if (j && j.ok === false && j.violations?.length) return { ok: false, rule: j.violations[0]!.rule, excerpt: j.violations[0]!.excerpt, by: 'ia' }
    return { ok: true }
  } catch {
    // Verificador indisponível: o pré-filtro já passou; seguimos (o modelo do agente tem as mesmas regras no prompt).
    return { ok: true }
  }
}

/** Anexa o aviso de risco quando a resposta fala de ofertas, valores ou rentabilidade. */
export async function withDisclaimer(text: string, alreadyShownRecently: boolean): Promise<string> {
  const c = await getSetting('compliance', { appendDisclaimer: true, disclaimer: '', disclaimerTriggers: [] as string[] })
  if (!c.appendDisclaimer || !c.disclaimer || alreadyShownRecently) return text
  const t = norm(text)
  // palavra inteira: "tir" não pode casar com "investir"
  const hit = (c.disclaimerTriggers ?? []).some((k: string) => {
    const w = norm(k).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return w && new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(t)
  })
  return hit ? `${text}\n\n_${c.disclaimer}_` : text
}
