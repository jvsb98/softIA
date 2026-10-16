import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

let masterKey: Buffer | null = null

export function setMasterKey(key: Buffer) {
  masterKey = key
}

function key(): Buffer {
  if (!masterKey) throw new Error('Chave-mestra não carregada')
  return masterKey
}

/** Cifra com AES-256-GCM. Formato: v1:<iv>:<tag>:<dados> (base64url). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':')
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return ''
  const [v, iv, tag, data] = value.split(':')
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Segredo em formato desconhecido')
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Mostra só o começo e o fim de um segredo (para exibir no painel). */
export function maskSecret(s: string): string {
  if (!s) return ''
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}

export function hmac(keyStr: string, payload: string): string {
  return createHmac('sha256', keyStr).update(payload).digest('hex')
}
