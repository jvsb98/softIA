/**
 * Pontos de extensão do atendimento. Módulos (IA, follow-ups, webhooks) se registram aqui
 * sem que o núcleo dependa deles diretamente.
 */
import { log } from '../lib/logger.js'

export interface InboundContext {
  conversation: any
  contact: any
  message: any
  connection: { id: string; name: string }
}

type InboundHook = (ctx: InboundContext) => Promise<void>

const inbound: { name: string; fn: InboundHook }[] = []

export const hooks = {
  registerInbound(name: string, fn: InboundHook) {
    inbound.push({ name, fn })
  },
  async onInbound(ctx: InboundContext) {
    for (const h of inbound) {
      try {
        await h.fn(ctx)
      } catch (err) {
        log().warn({ err, hook: h.name }, 'Falha num gancho de mensagem recebida')
      }
    }
  },
}
