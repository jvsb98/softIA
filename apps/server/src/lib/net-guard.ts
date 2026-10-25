/**
 * Proteção para requisições que o servidor faz a URLs informadas por usuários
 * (importar site na base de conhecimento, nó HTTP dos fluxos, webhooks).
 *
 * SaaS multi-cliente: por padrão também bloqueia a rede interna (10/8, 172.16/12, 192.168/16, 127/8,
 * 100.64/10, ::1, fc00::/7). Um cliente não pode usar o nó HTTP, webhooks ou a importação de site para
 * alcançar o banco, outros contêineres ou serviços internos do servidor.
 * Instalação de um único cliente que precise chamar a própria intranet: NET_GUARD_ALLOW_PRIVATE=true.
 *
 * Sempre bloqueado:
 *  - serviço de metadados da nuvem (169.254.169.254 na DigitalOcean/AWS/GCP) e toda a faixa link-local;
 *  - endereço "não especificado" (0.0.0.0, ::);
 *  - protocolos que não sejam http/https.
 *
 * O IP é conferido de novo na hora de abrir a conexão (lookup próprio no undici), o que fecha a brecha de
 * "DNS rebinding" (o nome resolve para um IP público na checagem e para um interno na conexão).
 */
import { lookup } from 'node:dns/promises'
import { lookup as lookupCb, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

const allowPrivate = () => (process.env.NET_GUARD_ALLOW_PRIVATE ?? 'false').toLowerCase() === 'true'

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
    const [a, b] = v4.split('.').map(Number) as [number, number]
    if (a === 0 || (a === 169 && b === 254) || (a === 100 && b === 100)) return true // 100.100.100.200 = metadados Alibaba
    if (allowPrivate()) return false
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const l = ip.toLowerCase()
  if (l === '::' || l.startsWith('fe80:') || l === 'fd00:ec2::254') return true
  if (allowPrivate()) return false
  return l === '::1' || /^f[cd][0-9a-f]{2}:/.test(l)
}

/** lookup usado na conexão: recusa se algum IP resolvido for bloqueado. */
function guardedLookup(hostname: string, options: any, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  lookupCb(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return cb(err, '')
    if (addresses.some((a) => blockedIp(a.address))) return cb(new Error('Endereço bloqueado por segurança (rede interna).'), '')
    if (options?.all) return cb(null, addresses)
    const first = addresses[0]!
    cb(null, first.address, first.family)
  })
}

const pinnedAgent = new Agent({ connect: { lookup: guardedLookup as any } })

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
  if (ips.some(blockedIp)) throw new Error('Endereço bloqueado por segurança (rede interna ou de metadados do servidor).')
  return u
}

/** fetch que valida o destino e cada redirecionamento (até 5). */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url
  let opts: RequestInit = { ...init, redirect: 'manual' }
  for (let hop = 0; hop <= 5; hop++) {
    await assertSafeUrl(current)
    const res = (await undiciFetch(current, { ...(opts as any), dispatcher: pinnedAgent })) as unknown as Response
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res
    current = new URL(res.headers.get('location')!, current).toString()
    // 303 (e 301/302 em POST, como fazem os navegadores) viram GET sem corpo
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && opts.method && opts.method !== 'GET')) {
      opts = { ...opts, method: 'GET', body: undefined }
    }
  }
  throw new Error('Redirecionamentos demais.')
}
