/**
 * Despachante da automação: decide o que fazer com uma conversa que está em "automation".
 * Ordem: fluxo publicado da conexão → agente de IA padrão → transferência direta para o setor padrão.
 */
import { one } from '../lib/db.js'
import { work, type Job } from '../lib/jobs.js'
import { log } from '../lib/logger.js'
import { getConversation, SYSTEM, transfer } from './service.js'

export type AutomationHandler = (conv: any, reason: string) => Promise<boolean>

const handlers: { name: string; fn: AutomationHandler }[] = []

/** Registra um manipulador. O primeiro que retornar true "assume" a conversa. */
export function registerAutomation(name: string, fn: AutomationHandler) {
  handlers.push({ name, fn })
}

export async function runAutomation(conversationId: string, reason = 'inbound') {
  const conv = await getConversation(conversationId)
  if (!conv || conv.status !== 'automation' || conv.ai_paused) return
  for (const h of handlers) {
    try {
      if (await h.fn(conv, reason)) return
    } catch (err) {
      log().error({ err, handler: h.name, conversationId }, 'Erro na automação — conversa enviada para humano')
      await transfer(conversationId, { sectorId: conv.sector_id }, SYSTEM, 'Falha na automação')
      return
    }
  }
  // Nenhuma automação configurada: vai direto para o setor padrão da conexão.
  const conn = await one<any>(`SELECT default_sector_id FROM connections WHERE id=$1`, [conv.connection_id])
  const fallback = conv.sector_id ?? conn?.default_sector_id ?? (await one<any>(`SELECT id FROM sectors WHERE active ORDER BY sort LIMIT 1`))?.id
  await transfer(conversationId, { sectorId: fallback }, SYSTEM, 'Entrada direta (sem automação configurada)')
}

export function registerAutomationWorker() {
  work(
    'conversation.process',
    async (job: Job<{ conversationId: string; reason?: string }>) => {
      await runAutomation(job.payload.conversationId, job.payload.reason)
    },
    4,
  )
}
