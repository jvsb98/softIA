/**
 * Fila de tarefas em segundo plano, 100% no PostgreSQL (sem Redis).
 *
 * - `FOR UPDATE SKIP LOCKED` para reservar tarefas;
 * - `LISTEN/NOTIFY` para acordar o worker na hora (com polling de segurança);
 * - `singletonKey` + modo `debounce` agrupa mensagens que chegam em sequência;
 * - `groupKey` garante que tarefas da mesma conversa nunca rodem em paralelo;
 * - novas tentativas com espera exponencial e recuperação de tarefas travadas.
 */
import { hostname } from 'node:os'
import type pg from 'pg'
import { db, q } from './db.js'
import { log } from './logger.js'

export interface EnqueueOptions {
  delayMs?: number
  runAt?: Date
  singletonKey?: string
  /** debounce: adia a tarefa existente; keep: mantém a existente; replace: substitui o payload sem adiar */
  mode?: 'debounce' | 'keep' | 'replace'
  groupKey?: string
  maxAttempts?: number
}

export interface Job<T = any> {
  id: number
  queue: string
  payload: T
  attempts: number
  max_attempts: number
  group_key: string | null
}

type Handler = (job: Job) => Promise<void>

const handlers = new Map<string, { fn: Handler; concurrency: number; running: number }>()
const workerId = `${hostname()}:${process.pid}`
let listenClient: pg.PoolClient | null = null
let timer: NodeJS.Timeout | null = null
let stopping = false
let ticking = false
let wakeRequested = false

export async function enqueue(queue: string, payload: object = {}, opts: EnqueueOptions = {}): Promise<number | null> {
  const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0))
  const maxAttempts = opts.maxAttempts ?? 5
  let rows: { id: number }[]
  if (opts.singletonKey) {
    const onConflict =
      opts.mode === 'keep'
        ? 'DO NOTHING'
        : opts.mode === 'replace'
          ? 'DO UPDATE SET payload = EXCLUDED.payload'
          : 'DO UPDATE SET payload = EXCLUDED.payload, run_at = GREATEST(jobs.run_at, EXCLUDED.run_at)'
    rows = await q(
      `INSERT INTO jobs(queue, payload, run_at, singleton_key, group_key, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (queue, singleton_key) WHERE status = 'queued' AND singleton_key IS NOT NULL
       ${onConflict}
       RETURNING id`,
      [queue, JSON.stringify(payload), runAt, opts.singletonKey, opts.groupKey ?? null, maxAttempts],
    )
  } else {
    rows = await q(
      `INSERT INTO jobs(queue, payload, run_at, group_key, max_attempts) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [queue, JSON.stringify(payload), runAt, opts.groupKey ?? null, maxAttempts],
    )
  }
  if (runAt.getTime() <= Date.now() + 50) await db().query(`NOTIFY na_jobs`).catch(() => {})
  return rows[0]?.id ?? null
}

export async function cancelSingleton(queue: string, singletonKey: string) {
  await q(`DELETE FROM jobs WHERE queue=$1 AND singleton_key=$2 AND status='queued'`, [queue, singletonKey])
}

export function work(queue: string, fn: Handler, concurrency = 2) {
  handlers.set(queue, { fn, concurrency, running: 0 })
}

async function claim(queue: string, limit: number): Promise<Job[]> {
  return q<Job>(
    `UPDATE jobs SET status='running', locked_at=now(), locked_by=$3, attempts=attempts+1
     WHERE id IN (
       SELECT j.id FROM jobs j
       WHERE j.queue=$1 AND j.status='queued' AND j.run_at <= now()
         AND (j.group_key IS NULL OR NOT EXISTS (
               SELECT 1 FROM jobs r WHERE r.status='running' AND r.group_key = j.group_key))
       ORDER BY j.run_at, j.id
       LIMIT $2
       FOR UPDATE SKIP LOCKED)
     RETURNING id, queue, payload, attempts, max_attempts, group_key`,
    [queue, limit, workerId],
  )
}

async function finish(job: Job, err?: unknown) {
  if (!err) {
    await q(`UPDATE jobs SET status='done', finished_at=now(), last_error=NULL WHERE id=$1`, [job.id])
    return
  }
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}`.slice(0, 4000) : String(err)
  if (job.attempts >= job.max_attempts) {
    await q(`UPDATE jobs SET status='failed', finished_at=now(), last_error=$2 WHERE id=$1`, [job.id, message])
    log().error({ queue: job.queue, jobId: job.id, err }, 'Tarefa falhou definitivamente')
  } else {
    const backoffSec = Math.min(600, 2 ** job.attempts * 5)
    // Se outra tarefa igual (singleton) já foi enfileirada, descarta esta para não violar o índice único.
    await q(
      `UPDATE jobs SET status='queued', run_at=now() + ($2 || ' seconds')::interval, last_error=$3, locked_at=NULL
       WHERE id=$1 AND NOT EXISTS (
         SELECT 1 FROM jobs o WHERE o.id<>$1 AND o.status='queued' AND o.queue=jobs.queue
           AND o.singleton_key IS NOT NULL AND o.singleton_key = jobs.singleton_key)`,
      [job.id, String(backoffSec), message],
    )
    await q(`UPDATE jobs SET status='failed', finished_at=now(), last_error=$2 WHERE id=$1 AND status='running'`, [job.id, message])
    log().warn({ queue: job.queue, jobId: job.id, attempt: job.attempts, err: (err as Error)?.message }, 'Tarefa falhou; nova tentativa agendada')
  }
}

async function tick() {
  if (ticking || stopping) {
    wakeRequested = true
    return
  }
  ticking = true
  try {
    do {
      wakeRequested = false
      for (const [queue, h] of handlers) {
        const free = h.concurrency - h.running
        if (free <= 0) continue
        const jobs = await claim(queue, free)
        for (const job of jobs) {
          h.running++
          h.fn(job)
            .then(() => finish(job))
            .catch((e) => finish(job, e))
            .finally(() => {
              h.running--
              void tick()
            })
        }
        if (jobs.length) wakeRequested = true
      }
    } while (wakeRequested && !stopping)
  } catch (err) {
    log().error({ err }, 'Erro no laço da fila de tarefas')
  } finally {
    ticking = false
  }
}

/** Intervalos recorrentes (equivalente a cron), registrados por nome. */
const schedules: NodeJS.Timeout[] = []
export function every(ms: number, queue: string, payload: object = {}) {
  const t = setInterval(() => {
    enqueue(queue, payload, { singletonKey: `every:${queue}`, mode: 'keep', maxAttempts: 1 }).catch(() => {})
  }, ms)
  t.unref()
  schedules.push(t)
}

export async function startJobs() {
  stopping = false
  // Recupera tarefas que ficaram "rodando" porque o serviço caiu no meio.
  await q(
    `UPDATE jobs SET status='queued', locked_at=NULL WHERE status='running' AND (locked_by=$1 OR locked_at < now() - interval '10 minutes')`,
    [workerId],
  )
  listenClient = await db().connect()
  await listenClient.query('LISTEN na_jobs')
  listenClient.on('notification', () => void tick())
  timer = setInterval(() => void tick(), 1000)
  timer.unref()

  // Limpeza diária de tarefas antigas concluídas.
  const cleanup = setInterval(() => {
    q(`DELETE FROM jobs WHERE status='done' AND finished_at < now() - interval '2 days'`).catch(() => {})
    q(`DELETE FROM jobs WHERE status='failed' AND finished_at < now() - interval '30 days'`).catch(() => {})
    q(`UPDATE jobs SET status='queued', locked_at=NULL WHERE status='running' AND locked_at < now() - interval '10 minutes'`).catch(() => {})
  }, 60 * 60 * 1000)
  cleanup.unref()
  schedules.push(cleanup)
  void tick()
}

export async function stopJobs() {
  stopping = true
  if (timer) clearInterval(timer)
  schedules.forEach(clearInterval)
  if (listenClient) {
    try {
      await listenClient.query('UNLISTEN *')
    } catch {
      /* ignora */
    }
    listenClient.release()
    listenClient = null
  }
}
