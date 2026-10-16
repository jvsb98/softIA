/**
 * Utilitários de linha de comando:
 *   npm run cli -- migrate                 aplica migrações
 *   npm run cli -- check                   testa o database.txt e a conexão com o banco
 *   npm run cli -- reset-admin <e-mail>    gera senha temporária e remove o 2FA de um usuário
 *   npm run cli -- export-key              mostra a chave-mestra (para migrar de servidor)
 *   npm run cli -- import-key <base64>     grava a chave-mestra trazida de outro servidor
 *   npm run cli -- protect-password        protege a senha do database.txt com DPAPI (Windows)
 *   npm run cli -- seed-demo               cria dados de demonstração (conexão, contatos, conversas)
 */
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
      console.log('Comandos: migrate | check | reset-admin <e-mail> | export-key | import-key <base64> | protect-password | seed-demo')
  }
}

main().catch((err) => {
  console.error(`Erro: ${err.message}`)
  process.exit(1)
})
