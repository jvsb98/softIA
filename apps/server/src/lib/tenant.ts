/**
 * Contexto de execução multi-cliente.
 *
 * Toda requisição, tarefa da fila ou evento do WhatsApp roda dentro de um contexto:
 *   - "tenant": um cliente; o banco só enxerga o schema dele (t_<slug>);
 *   - "platform": a camada do fornecedor; o banco enxerga o schema `plataforma`.
 *
 * Fora de um contexto, qualquer consulta falha (ver lib/db.ts). Isso é proposital:
 * um esquecimento vira erro visível, nunca uma consulta no schema errado.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantCtx {
  kind: 'tenant'
  id: string
  slug: string
  schema: string
  name: string
  status: string
}

export interface PlatformCtx {
  kind: 'platform'
}

export type ExecCtx = TenantCtx | PlatformCtx

const als = new AsyncLocalStorage<ExecCtx>()
const PLATFORM: PlatformCtx = Object.freeze({ kind: 'platform' })

export class NoContextError extends Error {
  constructor() {
    super('Consulta ao banco fora de um contexto de cliente ou de plataforma.')
  }
}

export function currentCtx(): ExecCtx | undefined {
  return als.getStore()
}

/** Cliente atual; lança erro fora de um contexto de cliente. */
export function currentTenant(): TenantCtx {
  const c = als.getStore()
  if (!c || c.kind !== 'tenant') throw new Error('Esta operação precisa de um contexto de cliente.')
  return c
}

export function tenantOrNull(): TenantCtx | null {
  const c = als.getStore()
  return c?.kind === 'tenant' ? c : null
}

export function withTenant<T>(t: TenantCtx, fn: () => T): T {
  return als.run(t, fn)
}

export function withPlatform<T>(fn: () => T): T {
  return als.run(PLATFORM, fn)
}

export function runInCtx<T>(ctx: ExecCtx, fn: () => T): T {
  return als.run(ctx, fn)
}

/** Prefixo de chaves de cache e salas de tempo real: "t:<id>:" ou "p:". */
export function ctxKey(): string {
  const c = als.getStore()
  if (!c) throw new NoContextError()
  return c.kind === 'tenant' ? `t:${c.id}:` : 'p:'
}

/** Nome de schema seguro para um slug ("clinica-x" → "t_clinica_x"). */
export function schemaForSlug(slug: string): string {
  const s = `t_${slug.replace(/-/g, '_')}`
  if (!/^t_[a-z0-9_]{1,40}$/.test(s)) throw new Error(`Slug inválido para schema: ${slug}`)
  return s
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
