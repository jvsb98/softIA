import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Versão do servidor: package.json ao lado de src/ ou dist/ (repositório e pacote instalado). */
export const APP_VERSION: string = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
