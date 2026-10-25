/**
 * Configuração do servidor.
 *
 * O servidor é apontado para o banco por um arquivo de texto simples, `database.txt`,
 * na pasta de configuração. No Windows a senha é protegida com DPAPI na primeira
 * execução (o arquivo é reescrito com `PASSWORD=dpapi:...`).
 *
 * Ordem de busca da pasta de configuração:
 *   1. variável de ambiente NIMBER_CONFIG_DIR
 *   2. ./config na raiz do repositório (desenvolvimento)
 *   3. Windows: %ProgramData%\NimberAtende\config  ·  Linux: /opt/nimber-atende/config
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DatabaseConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean | 'no-verify'
  sslCa?: string
  poolMax: number
  schema: string
}

export interface ServerConfig {
  port: number
  host: string
  publicUrl: string
  trustProxy: boolean
  logLevel: string
  dataDir: string
  /** Domínio-base dos clientes: <slug>.<baseDomain> (ex.: connectawork.app.br; em desenvolvimento, localhost) */
  baseDomain: string
  /** Hostname do painel do fornecedor (ex.: painel.connectawork.app.br) */
  platformHost: string
}

export interface AppConfig {
  configDir: string
  database: DatabaseConfig
  server: ServerConfig
  masterKey: Buffer
}

const isWindows = process.platform === 'win32'
const here = dirname(fileURLToPath(import.meta.url))

export function resolveConfigDir(): string {
  if (process.env.NIMBER_CONFIG_DIR) return resolve(process.env.NIMBER_CONFIG_DIR)
  // src/lib (dev) ou dist/lib (build) → raiz do repositório = ../../../..
  const repoConfig = resolve(here, '..', '..', '..', '..', 'config')
  if (existsSync(join(repoConfig, 'database.txt'))) return repoConfig
  if (isWindows) return join(process.env.ProgramData || 'C:\\ProgramData', 'NimberAtende', 'config')
  return '/opt/nimber-atende/config'
}

/** Lê um arquivo KEY=VALUE (aceita comentários com # e ;, e espaços em volta). */
export function parseKeyValueFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue
    const idx = line.indexOf('=')
    if (idx < 1) continue
    const key = line.slice(0, idx).trim().toUpperCase()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------- DPAPI (Windows)

function powershell(script: string, input: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

/** Protege um segredo com DPAPI no escopo da máquina (qualquer serviço desta máquina decifra; outra máquina não). */
export function dpapiProtect(plain: string): string {
  const script =
    'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); ' +
    '$b=[Text.Encoding]::UTF8.GetBytes($in); ' +
    '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); ' +
    '[Convert]::ToBase64String($p)'
  return 'dpapi:' + powershell(script, plain)
}

export function dpapiUnprotect(value: string): string {
  const script =
    'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); ' +
    '$b=[Convert]::FromBase64String($in); ' +
    '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine); ' +
    '[Text.Encoding]::UTF8.GetString($p)'
  return powershell(script, value.slice('dpapi:'.length))
}

function revealSecret(value: string, label: string): string {
  if (!value.startsWith('dpapi:')) return value
  if (!isWindows) {
    throw new Error(
      `${label} está protegido com DPAPI (Windows) e não pode ser lido neste sistema. ` +
        'No servidor de destino, informe a senha em texto puro no database.txt (ela será protegida novamente se for Windows).',
    )
  }
  return dpapiUnprotect(value)
}

// ---------------------------------------------------------------- database.txt

export const DATABASE_TEMPLATE = `# ==========================================================
#  softIA — conexão com o banco de dados (PostgreSQL)
# ==========================================================
#  Edite os valores abaixo e reinicie o serviço.
#  No Windows, a senha é protegida automaticamente (DPAPI) na primeira
#  execução: a linha PASSWORD passa a começar com "dpapi:".
#  Para trocar a senha, basta escrever a nova senha em texto puro.

HOST=localhost
PORT=5432
DATABASE=nimber_atende
USER=nimber_atende
PASSWORD=troque-esta-senha

# SSL: false (rede local) | true (verifica certificado) | no-verify (aceita certificado próprio)
#      Na DigitalOcean (cluster gerenciado) use: SSL=true e SSL_CA=ca-certificate.crt
SSL=false
# SSL_CA=ca-certificate.crt

# Opcional
POOL_MAX=15
SCHEMA=public
`

export const SERVER_TEMPLATE = `# ==========================================================
#  softIA — opções do servidor (opcional)
# ==========================================================
PORT=8080
# Endereço de escuta: 0.0.0.0 aceita acessos da rede; 127.0.0.1 só desta máquina
HOST=0.0.0.0
# Endereço público usado nos links (ex.: https://atendimento.nimber.com.br)
PUBLIC_URL=http://localhost:8080
# true quando estiver atrás de um proxy reverso (Caddy, Nginx, Cloudflare Tunnel)
TRUST_PROXY=false
# fatal | error | warn | info | debug
LOG_LEVEL=info
`

function loadDatabase(configDir: string): DatabaseConfig {
  const file = join(configDir, 'database.txt')
  // Em contêiner (Docker/DigitalOcean) a conexão pode vir só de variáveis de ambiente NIMBER_DB_*
  const fromEnv = !!process.env.NIMBER_DB_HOST
  if (!existsSync(file) && !fromEnv) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(file, DATABASE_TEMPLATE, 'utf8')
    throw new Error(
      `Arquivo de configuração criado em ${file}. Preencha os dados do PostgreSQL e inicie o serviço novamente.`,
    )
  }
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const kv = parseKeyValueFile(text)
  const env = process.env
  let password = env.NIMBER_DB_PASSWORD ?? kv.PASSWORD ?? ''

  // Primeira execução no Windows: protege a senha e regrava o arquivo preservando os comentários.
  if (isWindows && password && !password.startsWith('dpapi:') && !env.NIMBER_DB_PASSWORD) {
    try {
      const protectedValue = dpapiProtect(password)
      text = text.replace(/^(\s*PASSWORD\s*=).*$/im, `$1${protectedValue}`)
      writeFileSync(file, text, 'utf8')
      password = protectedValue
    } catch {
      // Sem PowerShell disponível: segue com a senha em texto puro.
    }
  }

  const sslRaw = (env.NIMBER_DB_SSL ?? kv.SSL ?? 'false').toLowerCase()
  let sslCa: string | undefined
  const caPath = env.NIMBER_DB_SSL_CA ?? kv.SSL_CA
  if (caPath?.includes('-----BEGIN')) {
    sslCa = caPath.replace(/\\n/g, '\n') // certificado colado direto na variável de ambiente
  } else if (caPath) {
    const p = resolve(configDir, caPath)
    if (existsSync(p)) sslCa = readFileSync(p, 'utf8')
  }

  return {
    host: env.NIMBER_DB_HOST ?? kv.HOST ?? 'localhost',
    port: Number(env.NIMBER_DB_PORT ?? kv.PORT ?? 5432),
    database: env.NIMBER_DB_NAME ?? kv.DATABASE ?? 'nimber_atende',
    user: env.NIMBER_DB_USER ?? kv.USER ?? 'nimber_atende',
    password: revealSecret(password, 'PASSWORD do database.txt'),
    ssl: sslRaw === 'true' ? true : sslRaw === 'no-verify' ? 'no-verify' : false,
    sslCa,
    poolMax: Number(env.NIMBER_DB_POOL_MAX ?? kv.POOL_MAX ?? 10),
    schema: env.NIMBER_DB_SCHEMA ?? kv.SCHEMA ?? 'public',
  }
}

function loadServer(configDir: string): ServerConfig {
  const file = join(configDir, 'server.txt')
  const kv = existsSync(file) ? parseKeyValueFile(readFileSync(file, 'utf8')) : {}
  const env = process.env
  const port = Number(env.PORT ?? kv.PORT ?? 8080)
  const dataDir = resolve(configDir, '..', 'data')
  const baseDomain = (env.BASE_DOMAIN ?? kv.BASE_DOMAIN ?? 'localhost').toLowerCase().replace(/^\.+|\.+$/g, '')
  return {
    port,
    host: env.HOST ?? kv.HOST ?? '0.0.0.0',
    publicUrl: (env.PUBLIC_URL ?? kv.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    trustProxy: (env.TRUST_PROXY ?? kv.TRUST_PROXY ?? 'false').toLowerCase() === 'true',
    logLevel: env.LOG_LEVEL ?? kv.LOG_LEVEL ?? 'info',
    dataDir,
    baseDomain,
    platformHost: (env.PLATFORM_HOST ?? kv.PLATFORM_HOST ?? `painel.${baseDomain}`).toLowerCase(),
  }
}

/**
 * Chave-mestra (32 bytes) usada para cifrar segredos guardados no banco
 * (chaves de API de IA, senhas de bancos externos, segredo do 2FA).
 * Gerada na primeira execução. No Windows é guardada protegida por DPAPI.
 * Para migrar de servidor: `npm run cli -- export-key` na origem e
 * `import-key` no destino (veja docs/GUIA-DIGITALOCEAN.md).
 */
function loadMasterKey(configDir: string): Buffer {
  if (process.env.NIMBER_MASTER_KEY) return decodeKey(process.env.NIMBER_MASTER_KEY)
  const file = join(configDir, 'master.key')
  if (!existsSync(file)) {
    mkdirSync(configDir, { recursive: true })
    const key = randomBytes(32).toString('base64')
    let stored = key
    if (isWindows) {
      try {
        stored = dpapiProtect(key)
      } catch {
        /* sem PowerShell: grava em texto (a pasta deve ter permissão restrita) */
      }
    }
    writeFileSync(file, stored + '\n', { encoding: 'utf8', mode: 0o600 })
    return decodeKey(key)
  }
  return decodeKey(revealSecret(readFileSync(file, 'utf8').trim(), 'master.key'))
}

function decodeKey(b64: string): Buffer {
  const buf = Buffer.from(b64.trim(), 'base64')
  if (buf.length !== 32) throw new Error('Chave-mestra inválida: esperado 32 bytes em base64.')
  return buf
}

export function writeMasterKey(configDir: string, b64: string) {
  decodeKey(b64)
  let stored = b64.trim()
  if (isWindows) {
    try {
      stored = dpapiProtect(stored)
    } catch {
      /* mantém texto */
    }
  }
  writeFileSync(join(configDir, 'master.key'), stored + '\n', { encoding: 'utf8', mode: 0o600 })
}

export function readMasterKeyPlain(configDir: string): string {
  return loadMasterKey(configDir).toString('base64')
}

let cached: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cached) return cached
  const configDir = resolveConfigDir()
  cached = {
    configDir,
    database: loadDatabase(configDir),
    server: loadServer(configDir),
    masterKey: loadMasterKey(configDir),
  }
  return cached
}
