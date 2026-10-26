/**
 * Roteamento por tarefa: cada tarefa (triagem, agente, guarda, resumo, transcrição, embeddings)
 * tem um provedor/modelo principal e um reserva. Falhou o principal → usa o reserva e registra.
 */
import { one, q } from '../lib/db.js'
import { log } from '../lib/logger.js'
import { chat, embed, ProviderError, transcribe, type ChatRequest, type ChatResult, type ProviderRow } from './providers.js'
import { ctxKey, tenantOrNull } from '../lib/tenant.js'
import { isModuleOn, limitsOf } from '../platform/modules.js'

export type Task = 'triage' | 'agent' | 'guard' | 'summary' | 'transcription' | 'embedding'

interface TaskConfig {
  task: Task
  primary: { provider: ProviderRow; model: string } | null
  fallback: { provider: ProviderRow; model: string } | null
  temperature: number
  max_tokens: number
}

const cache = new Map<string, { cfg: TaskConfig; at: number }>()

export function invalidateAiCache() {
  cache.clear()
}

export async function taskConfig(task: Task): Promise<TaskConfig> {
  const c = cache.get(ctxKey() + task)
  if (c && Date.now() - c.at < 15_000) return c.cfg
  const row = await one<any>(
    // Provedores e modelos são da plataforma (chaves do fornecedor), iguais para todos os clientes
    `SELECT t.*, row_to_json(p) AS p, row_to_json(f) AS f
       FROM plataforma.ai_task_models t
       LEFT JOIN plataforma.ai_providers p ON p.id = t.provider_id AND p.enabled
       LEFT JOIN plataforma.ai_providers f ON f.id = t.fallback_provider_id AND f.enabled
      WHERE t.task = $1`,
    [task],
  )
  const cfg: TaskConfig = {
    task,
    primary: row?.p ? { provider: row.p, model: row.model } : null,
    fallback: row?.f ? { provider: row.f, model: row.fallback_model || row.model } : null,
    temperature: Number(row?.temperature ?? 0.3),
    max_tokens: Number(row?.max_tokens ?? 1024),
  }
  cache.set(ctxKey() + task, { cfg, at: Date.now() })
  return cfg
}

async function recordUsage(task: Task, kind: string, model: string, conversationId: string | null, r: Partial<ChatResult> | null, ms: number, ok: boolean, fallback: boolean, error?: string) {
  const params = [task, kind, model, conversationId, r?.usage?.input ?? null, r?.usage?.output ?? null, ms, ok, fallback, error?.slice(0, 500) ?? null]
  // No cliente (relatórios dele) e na plataforma (franquia e tela do fornecedor)
  await q(
    `INSERT INTO ai_usage(task, provider_kind, model, conversation_id, input_tokens, output_tokens, latency_ms, ok, fallback_used, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    params,
  ).catch(() => {})
  const t = tenantOrNull()
  if (t) {
    await q(
      `INSERT INTO plataforma.ai_usage(tenant_id, task, provider_kind, model, conversation_id, input_tokens, output_tokens, latency_ms, ok, fallback_used, error)
       VALUES ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [...params, t.id],
    ).catch(() => {})
    tokensCache.delete(t.id)
  }
}

export class AiUnavailable extends Error {}

const tokensCache = new Map<string, { n: number; at: number }>()
const warned = new Map<string, string>()

/** Tokens de IA consumidos pelo cliente no mês corrente (fuso de São Paulo). */
export async function tokensThisMonth(tenantId: string): Promise<number> {
  const c = tokensCache.get(tenantId)
  if (c && Date.now() - c.at < 60_000) return c.n
  const r = await one<{ n: number }>(
    `SELECT coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::bigint AS n FROM plataforma.ai_usage
      WHERE tenant_id=$1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
    [tenantId],
  )
  const n = Number(r?.n ?? 0)
  tokensCache.set(tenantId, { n, at: Date.now() })
  return n
}

/** Módulo de IA contratado e franquia do mês. Sem IA, quem chama transfere para humano (mesmo caminho de "IA indisponível"). */
async function assertAiAllowed() {
  const t = tenantOrNull()
  if (!t) return
  if (!isModuleOn(t, 'ia')) throw new AiUnavailable('Módulo de IA não contratado')
  const lim = limitsOf(t)
  if (!lim.aiTokensMonth) return
  const used = await tokensThisMonth(t.id)
  if (used < lim.aiTokensMonth) return
  if (lim.aiOverage === 'bloquear') throw new AiUnavailable('Franquia mensal de IA esgotada')
  const month = new Date().toISOString().slice(0, 7)
  if (warned.get(t.id) !== month) {
    warned.set(t.id, month)
    log().warn({ tenant: t.slug, used, limit: lim.aiTokensMonth }, 'Franquia de IA estourada (aviso, IA continua ativa)')
  }
}

/** Executa uma tarefa de chat com principal → reserva. */
export async function runChat(task: Task, req: Omit<ChatRequest, 'model'>, conversationId: string | null = null): Promise<ChatResult & { model: string; provider: string; fallback: boolean }> {
  await assertAiAllowed()
  const cfg = await taskConfig(task)
  const attempts = [cfg.primary, cfg.fallback].filter(Boolean) as { provider: ProviderRow; model: string }[]
  if (!attempts.length) throw new AiUnavailable(`Nenhum provedor configurado para a tarefa "${task}"`)
  let lastErr: unknown
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!
    const t0 = Date.now()
    try {
      const r = await chat(a.provider, {
        ...req,
        model: a.model,
        temperature: req.temperature ?? cfg.temperature,
        maxTokens: req.maxTokens ?? cfg.max_tokens,
        mockHint: req.mockHint ?? task,
      })
      await recordUsage(task, a.provider.kind, a.model, conversationId, r, Date.now() - t0, true, i > 0)
      return { ...r, model: a.model, provider: a.provider.name, fallback: i > 0 }
    } catch (err: any) {
      lastErr = err
      await recordUsage(task, a.provider.kind, a.model, conversationId, null, Date.now() - t0, false, i > 0, err?.message)
      log().warn({ task, provider: a.provider.name, model: a.model, err: err?.message }, i + 1 < attempts.length ? 'IA falhou; usando reserva' : 'IA falhou')
      if (err instanceof ProviderError && !err.retryable && i + 1 >= attempts.length) break
    }
  }
  throw new AiUnavailable(`IA indisponível para "${task}": ${(lastErr as Error)?.message ?? 'erro'}`)
}

export async function runTranscription(audio: Buffer, mime: string, conversationId: string | null) {
  try {
    await assertAiAllowed()
  } catch {
    return null
  }
  const cfg = await taskConfig('transcription')
  for (const a of [cfg.primary, cfg.fallback].filter(Boolean) as { provider: ProviderRow; model: string }[]) {
    const t0 = Date.now()
    try {
      const text = await transcribe(a.provider, a.model, audio, mime)
      await recordUsage('transcription', a.provider.kind, a.model, conversationId, null, Date.now() - t0, true, a !== cfg.primary)
      return text
    } catch (err: any) {
      await recordUsage('transcription', a.provider.kind, a.model, conversationId, null, Date.now() - t0, false, a !== cfg.primary, err?.message)
    }
  }
  return null
}

export async function runEmbedding(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
  try {
    await assertAiAllowed()
  } catch {
    return null
  }
  const cfg = await taskConfig('embedding')
  for (const a of [cfg.primary, cfg.fallback].filter(Boolean) as { provider: ProviderRow; model: string }[]) {
    if (a.provider.kind === 'mock' || a.provider.kind === 'anthropic') continue
    const t0 = Date.now()
    try {
      const vectors = await embed(a.provider, a.model, texts)
      await recordUsage('embedding', a.provider.kind, a.model, null, null, Date.now() - t0, true, a !== cfg.primary)
      return { vectors, model: `${a.provider.kind}:${a.model}` }
    } catch (err: any) {
      await recordUsage('embedding', a.provider.kind, a.model, null, null, Date.now() - t0, false, a !== cfg.primary, err?.message)
    }
  }
  return null
}
