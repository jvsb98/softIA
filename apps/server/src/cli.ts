/**
 * Utilitários de linha de comando:
 *   npm run cli -- migrate                 aplica migrações
 *   npm run cli -- check                   testa o database.txt e a conexão com o banco
 *   npm run cli -- reset-admin <e-mail>    gera senha temporária e remove o 2FA de um usuário
 *   npm run cli -- export-key              mostra a chave-mestra (para migrar de servidor)
 *   npm run cli -- import-key <base64>     grava a chave-mestra trazida de outro servidor
 *   npm run cli -- protect-password        protege a senha do database.txt com DPAPI (Windows)
 *   npm run cli -- seed-demo               cria dados de demonstração (conexão, contatos, conversas)
 *   npm run cli -- backup --out <pasta> [--keep 14] [--pg-dump <caminho do pg_dump>]
 *                                          cópia do banco (pg_dump formato custom) com rotação
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, readMasterKeyPlain, resolveConfigDir, writeMasterKey } from './lib/config.js'
import { randomToken, setMasterKey } from './lib/crypto.js'
import { createPool, migrate, one, q } from './lib/db.js'
import { createLogger } from './lib/logger.js'

const [cmd, ...args] = process.argv.slice(2)

async function withDb<T>(fn: () => Promise<T>) {
  const cfg = loadConfig()
  createLogger('warn')
  setMasterKey(cfg.masterKey)
  const pool = createPool(cfg.database)
  try {
    return await fn()
  } finally {
    await pool.end()
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** Encontra o pg_dump: --pg-dump, PATH ou instalações padrão do PostgreSQL no Windows (versão mais nova). */
function findPgDump(explicit?: string): string {
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\PostgreSQL'
    if (existsSync(base)) {
      const versions = readdirSync(base)
        .filter((v) => existsSync(join(base, v, 'bin', 'pg_dump.exe')))
        .sort((a, b) => Number(b) - Number(a))
      if (versions[0]) return join(base, versions[0], 'bin', 'pg_dump.exe')
    }
  }
  return 'pg_dump'
}

/**
 * Backup do banco com pg_dump (formato custom, restaurável com pg_restore).
 * Usa a configuração do servidor (inclusive a senha protegida por DPAPI), então
 * a senha nunca precisa ficar em texto puro num script ou tarefa agendada.
 */
async function backup(args: string[]) {
  const out = flag(args, 'out')
  if (!out) throw new Error('Informe a pasta: backup --out D:\\Backups\\NimberAtende [--keep 14]')
  const keep = Number(flag(args, 'keep') ?? 14)
  const cfg = loadConfig()
  const db = cfg.database
  mkdirSync(out, { recursive: true })
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}` // horário local
  const file = join(out, `nimber-atende-${stamp}.dump`)
  const pgDump = findPgDump(flag(args, 'pg-dump'))
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: db.password }
  if (db.ssl) env.PGSSLMODE = 'require' // conexão cifrada; a verificação do certificado fica com o servidor
  console.log(`Gerando ${file} com ${pgDump}…`)
  await new Promise<void>((resolve, reject) => {
    const p = spawn(pgDump, ['-h', db.host, '-p', String(db.port), '-U', db.user, '-d', db.database, '-Fc', '-Z', '6', '--no-owner', '-f', file], {
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    p.on('error', (e) => reject(new Error(`Não consegui executar o pg_dump (${e.message}). Use --pg-dump "C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe".`)))
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump terminou com código ${code}`))))
  })
  const size = statSync(file).size
  console.log(`Backup concluído: ${(size / 1024 / 1024).toFixed(1)} MB`)
  // Rotação: mantém os N mais recentes
  const old = readdirSync(out)
    .filter((f) => /^nimber-atende-\d{8}-\d{4}\.dump$/.test(f))
    .sort()
    .reverse()
    .slice(keep)
  for (const f of old) unlinkSync(join(out, f))
  if (old.length) console.log(`Removidos ${old.length} backup(s) antigo(s) (mantendo ${keep}).`)
  console.log('Lembrete: a chave mestra (export-key) não vai no backup. Guarde-a uma vez num cofre de senhas.')
}

async function main() {
  switch (cmd) {
    case 'migrate': {
      const r = await withDb(() => migrate())
      console.log(r.applied.length ? `Migrações aplicadas: ${r.applied.join(', ')}` : 'Banco já está atualizado.')
      break
    }
    case 'check': {
      const cfg = loadConfig()
      console.log(`Pasta de configuração: ${cfg.configDir}`)
      console.log(`Banco: ${cfg.database.user}@${cfg.database.host}:${cfg.database.port}/${cfg.database.database} (SSL: ${cfg.database.ssl})`)
      await withDb(async () => {
        const r = await one(`SELECT version() AS v, current_database() AS db`)
        console.log(`Conexão OK — ${r.v}`)
      })
      break
    }
    case 'reset-admin': {
      const email = args[0]
      if (!email) throw new Error('Informe o e-mail: npm run cli -- reset-admin pessoa@nimber.com.br')
      await withDb(async () => {
        const { hashPassword } = await import('./auth/service.js')
        const temp = `Nimber-${randomToken(6)}1`
        const r = await q(
          `UPDATE users SET password_hash=$2, must_change_password=true, failed_logins=0, locked_until=NULL,
                  totp_enabled=false, totp_secret_enc=NULL, recovery_codes='[]', active=true
            WHERE lower(email)=lower($1) RETURNING id`,
          [email, await hashPassword(temp)],
        )
        if (!r.length) throw new Error('Usuário não encontrado.')
        await q(`UPDATE user_sessions SET revoked_at=now() WHERE user_id=$1`, [r[0].id])
        console.log(`Senha temporária de ${email}: ${temp}\nO 2FA foi removido; configure novamente no próximo acesso.`)
      })
      break
    }
    case 'export-key': {
      console.log(readMasterKeyPlain(resolveConfigDir()))
      break
    }
    case 'import-key': {
      if (!args[0]) throw new Error('Informe a chave: npm run cli -- import-key <base64>')
      writeMasterKey(resolveConfigDir(), args[0])
      console.log('Chave-mestra gravada.')
      break
    }
    case 'protect-password': {
      loadConfig() // a proteção acontece ao carregar a configuração no Windows
      console.log('Senha do database.txt verificada (protegida com DPAPI no Windows).')
      break
    }
    case 'backup': {
      await backup(args)
      break
    }
    case 'seed-demo': {
      await withDb(async () => {
        await migrate()
        const { seedDemo } = await import('./ops/demo.js')
        const r = await seedDemo()
        console.log(`Dados de demonstração criados: ${r.conversations} conversas na conexão "${r.connection}".`)
      })
      break
    }
    default:
      console.log('Comandos: migrate | check | reset-admin <e-mail> | export-key | import-key <base64> | protect-password | backup --out <pasta> [--keep 14] | seed-demo')
  }
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`)
  process.exit(1)
})
