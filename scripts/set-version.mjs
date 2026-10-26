#!/usr/bin/env node
// Atualiza a versão em todos os package.json do projeto.
// Uso:  node scripts/set-version.mjs 1.1.0
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const v = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v ?? '')) {
  console.error('Informe a versão no formato 1.2.3 — ex.: node scripts/set-version.mjs 1.1.0')
  process.exit(1)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const p of ['package.json', 'apps/server/package.json', 'apps/web/package.json']) {
  const file = join(root, p)
  const json = JSON.parse(readFileSync(file, 'utf8'))
  json.version = v
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
  console.log(`${p} → ${v}`)
}
console.log(`\nAgora:  npm install  (atualiza o package-lock)  →  git commit -am "Versão ${v}"  →  git tag v${v}  →  git push --follow-tags`)
