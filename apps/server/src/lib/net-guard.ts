/**
 * Proteção para requisições que o servidor faz a URLs informadas por usuários
 * (importar site na base de conhecimento, nó HTTP dos fluxos, webhooks).
 *
 * Endereços da rede interna continuam permitidos de propósito (n8n, CRM e intranet da Nimber).
 * Bloqueamos o que nunca é destino legítimo e pode vazar dados do servidor:
 *  - serviço de metadados da nuvem (169.254.169.254 na DigitalOcean/AWS/GCP) e toda a faixa link-local;
 *  - endereço "não especificado" (0.0.0.0, ::);
 *  - protocolos que não sejam http/https.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** ::ffff:169.254.169.254 e ::ffff:a9fe:a9fe (forma normalizada pelo URL) → 169.254.169.254 */
function mappedV4(ip: string): string {
  const l = ip.toLowerCase()
  if (!l.startsWith('::ffff:')) return ip
  const rest = l.slice(7)
  if (isIP(rest) === 4) return rest
  const m = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!m) return ip
  const hi = parseInt(m[1]!, 16)
  const lo = parseInt(m[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

function blockedIp(ip: string): boolean {
  const v4 = mappedV4(ip)
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number)
    return a === 0 || (a === 169 && b === 254) || (a === 100 && b === 100) // 100.100.100.200 = metadados Alibaba
  }
  const l = ip.toLowerCase()
  return l === '::' || l.startsWith('fe80:') || l === 'fd00:ec2::254'
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('URL inválida.')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Só são permitidas URLs http ou https.')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^metadata(\.google\.internal)?$/i.test(host)) throw new Error('Endereço bloqueado por segurança.')
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address)
  if (ips.some(blockedIp)) throw new Error('Endereço bloqueado por segurança (rede de metadados do servidor).')
  return u
}

/** fetch que valida o destino e cada redirecionamento (até 5). */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url
  let opts: RequestInit = { ...init, redirect: 'manual' }
  for (let hop = 0; hop <= 5; hop++) {
    await assertSafeUrl(current)
    const res = await fetch(current, opts)
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res
    current = new URL(res.headers.get('location')!, current).toString()
    // 303 (e 301/302 em POST, como fazem os navegadores) viram GET sem corpo
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method && opts.method !== 'GET')) {
      opts = { ...opts, method: 'GET', body: undefined }
    }
  }
  throw new Error('Redirecionamentos demais.')
}
