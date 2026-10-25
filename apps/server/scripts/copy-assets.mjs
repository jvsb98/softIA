// Copia as migrações SQL para dist/ (o build do TypeScript só leva .ts → .js)
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'dist', 'migrations')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(join(root, 'migrations'), target, { recursive: true })
console.log('migrations copiadas para dist/migrations')
