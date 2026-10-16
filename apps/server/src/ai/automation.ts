/**
 * Liga a IA ao atendimento:
 *  - automação padrão: sem fluxo de entrada, o agente de IA padrão atende;
 *  - transcrição de áudios recebidos (antes da IA processar a conversa).
 */
import { one, q } from '../lib/db.js'
import { enqueue, work, type Job } from '../lib/jobs.js'
import { registerAutomation } from '../inbox/automation.js'
import { hooks } from '../inbox/hooks.js'
import { getConversation } from '../inbox/service.js'
import { emitConversation } from '../http/realtime.js'
import { getSetting } from '../ops/settings.js'
import { applyOutcome, defaultAgent, registerAgentWorkers, runAgentTurn } from './agent.js'
import { registerKbWorkers } from './kb.js'
import { runTranscription } from './router.js'

export function registerAi() {
  registerKbWorkers()
  registerAgentWorkers()

  // Automação padrão (prioridade menor que a dos fluxos, registrados depois na fase 3 com unshift)
  registerAutomation('ai-default-agent', async (conv) => {
    const ai = await getSetting('ai', { enabled: true })
    if (!ai.enabled) return false
    const agent = await defaultAgent()
    if (!agent) return false
    const outcome = await runAgentTurn(conv, { executeOutcome: true })
    const fresh = await getConversation(conv.id)
    if (!fresh || fresh.status !== 'automation') return true // um humano assumiu no meio do caminho
    await applyOutcome(fresh, outcome)
    return true
  })

  // Áudio recebido → transcrição (mesmo grupo da conversa: a IA espera a transcrição terminar)
  hooks.registerInbound('transcription', async ({ message, conversation }) => {
    if (message.kind !== 'audio' || !message.media_id && !message.media) return
    await enqueue('ai.transcribe', { messageId: message.id }, { groupKey: `conv:${conversation.id}`, maxAttempts: 2 })
  })

  work(
    'ai.transcribe',
    async (job: Job<{ messageId: string }>) => {
      const m = await one<any>(`SELECT m.id, m.conversation_id, f.data, f.mime FROM messages m JOIN media_files f ON f.id=m.media_id WHERE m.id=$1`, [job.payload.messageId])
      if (!m?.data) return
      const text = await runTranscription(m.data, m.mime, m.conversation_id)
      if (!text) return
      await q(`UPDATE messages SET transcript=$2 WHERE id=$1`, [m.id, text])
      const conv = await getConversation(m.conversation_id)
      if (conv) emitConversation(conv, 'message:status', { id: m.id, conversation_id: m.conversation_id, transcript: text })
    },
    2,
  )
}
