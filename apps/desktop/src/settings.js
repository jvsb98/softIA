// Preferências do app desktop (arquivo JSON na pasta do usuário) e endereço padrão do servidor.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const file = () => path.join(app.getPath('userData'), 'config.json')

function read() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
}

function write(patch) {
  const next = { ...read(), ...patch }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2))
  return next
}

/** Aceita "servidor:8080", "http://servidor:8080/" etc. Retorna a origem (sem barra final) ou null. */
function normalizeUrl(input) {
  let s = String(input || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.origin
  } catch {
    return null
  }
}

/**
 * Endereço pré-configurado pela TI (na ordem):
 *   1. argumento --server=http://...
 *   2. variável de ambiente NIMBER_SERVER_URL
 *   3. %ProgramData%\NimberAtende\desktop-server.txt  (útil para distribuir em várias máquinas)
 *   4. server-url.txt embutido no instalador (apps/desktop/server-url.txt no build)
 */
function presetUrl() {
  const arg = process.argv.find((a) => a.startsWith('--server='))
  if (arg) return normalizeUrl(arg.slice('--server='.length))
  if (process.env.NIMBER_SERVER_URL) return normalizeUrl(process.env.NIMBER_SERVER_URL)
  const candidates = [
    process.env.ProgramData && path.join(process.env.ProgramData, 'NimberAtende', 'desktop-server.txt'),
    process.resourcesPath && path.join(process.resourcesPath, 'server-url.txt'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const line = fs
        .readFileSync(p, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'))
      const url = normalizeUrl(line)
      if (url) return url
    } catch {
      /* arquivo ausente */
    }
  }
  return null
}

module.exports = { read, write, normalizeUrl, presetUrl }
