#!/usr/bin/env node
/**
 * Monta o pacote de produção do servidor em out/softia/:
 *
 *   out/softia/
 *     server/dist/        servidor compilado (+ migrations)
 *     server/web/         front-end compilado (servido pelo próprio servidor)
 *     server/patches/     correção do Baileys (aplicada no npm install)
 *     server/node_modules dependências de produção, nas MESMAS versões do desenvolvimento
 *     config-exemplo/     modelos de database.txt e server.txt
 *
 * Uso:  npm run build && node scripts/package-server.mjs [--skip-install]
 * O instalador Windows (deploy/windows) e a imagem Docker partem desta pasta.
 */
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'out', 'softia')
const server = join(out, 'server')
const skipInstall = process.argv.includes('--skip-install')

const need = (p, hint) => {
  if (!existsSync(p)) {
    console.error(`Faltando ${p}. ${hint}`)
    process.exit(1)
  }
}
need(join(root, 'apps/server/dist/index.js'), 'Rode "npm run build" antes.')
need(join(root, 'apps/web/dist/index.html'), 'Rode "npm run build" antes.')

rmSync(out, { recursive: true, force: true })
mkdirSync(server, { recursive: true })

cpSync(join(root, 'apps/server/dist'), join(server, 'dist'), { recursive: true })
cpSync(join(root, 'apps/web/dist'), join(server, 'web'), { recursive: true })
cpSync(join(root, 'patches'), join(server, 'patches'), { recursive: true })
mkdirSync(join(out, 'config-exemplo'), { recursive: true })
for (const f of ['database.example.txt', 'server.example.txt']) cpSync(join(root, 'config', f), join(out, 'config-exemplo', f))

// package.json de produção com as versões exatas instaladas no repositório
const src = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'))
const installed = (name) => {
  for (const base of [join(root, 'apps/server/node_modules'), join(root, 'node_modules')]) {
    const p = join(base, name, 'package.json')
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version
  }
  throw new Error(`Dependência ${name} não está instalada. Rode "npm ci" na raiz.`)
}
const deps = Object.fromEntries(Object.keys(src.dependencies).map((n) => [n, installed(n)]))
deps['patch-package'] = installed('patch-package')
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(
  join(server, 'package.json'),
  JSON.stringify(
    {
      name: 'softia-server',
      version: rootPkg.version,
      private: true,
      type: 'module',
      main: 'dist/index.js',
      engines: { node: '>=22' },
      scripts: {
        start: 'node dist/index.js',
        cli: 'node dist/cli.js',
        postinstall: 'patch-package',
      },
      dependencies: deps,
    },
    null,
    2,
  ) + '\n',
)
writeFileSync(join(out, 'VERSION'), rootPkg.version + '\n')

if (!skipInstall) {
  console.log('Instalando dependências de produção…')
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: server, stdio: 'inherit' })
  // garante que o patch do Baileys foi aplicado
  const sock = readFileSync(join(server, 'node_modules/@whiskeysockets/baileys/lib/Socket/socket.js'), 'utf8')
  if (!sock.includes('makePairingQRRenderer')) {
    console.error('O patch do Baileys não foi aplicado (patches/). O pareamento por QR Code pode falhar.')
    process.exit(1)
  }
}
console.log(`Pacote pronto em ${out}`)
