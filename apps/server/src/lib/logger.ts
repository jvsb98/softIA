import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'

let root: Logger | null = null

/**
 * Logger principal. Em produção grava JSON em data/logs/servidor.log (rotação
 * diária via pino/file + nome com data) e também no console.
 * Em desenvolvimento usa pino-pretty se estiver instalado.
 */
export function createLogger(level: string, dataDir?: string): Logger {
  const targets: pino.TransportTargetOptions[] = []
  const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY
  targets.push(
    pretty
      ? { target: 'pino-pretty', level, options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : { target: 'pino/file', level, options: { destination: 1 } },
  )
  if (dataDir) {
    const dir = join(dataDir, 'logs')
    try {
      mkdirSync(dir, { recursive: true })
      const day = new Date().toISOString().slice(0, 10)
      targets.push({ target: 'pino/file', level, options: { destination: join(dir, `servidor-${day}.log`), mkdir: true } })
    } catch {
      /* sem permissão de escrita: só console */
    }
  }
  root = pino(
    {
      level,
      base: { app: 'nimber-atende' },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Segredos nunca vão para o log, mesmo que algum objeto seja registrado por engano
      redact: {
        paths: ['password', '*.password', 'apiKey', '*.apiKey', 'secret', '*.secret', 'token', '*.token', 'headers.cookie', '*.headers.cookie', 'headers.authorization', '*.headers.authorization', 'err.client'],
        censor: '[oculto]',
      },
    },
    pino.transport({ targets }),
  )
  return root
}

export function log(): Logger {
  if (!root) root = pino({ level: process.env.LOG_LEVEL || 'info' })
  return root
}
