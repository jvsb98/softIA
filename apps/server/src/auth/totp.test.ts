import assert from 'node:assert/strict'
import { test } from 'node:test'
import { base32Decode, base32Encode, hotp, verifyTotp, totp } from './totp.js'

test('RFC 4226 vetores de teste do HOTP', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'))
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  expected.forEach((code, i) => assert.equal(hotp(secret, i), code))
})

test('base32 ida e volta', () => {
  const b = Buffer.from('nimber-atende-2fa')
  assert.deepEqual(base32Decode(base32Encode(b)), b)
})

test('TOTP aceita janela de ±30s', () => {
  const s = base32Encode(Buffer.from('segredo-de-teste-123'))
  const now = Date.now()
  assert.ok(verifyTotp(s, totp(s, now - 30_000), now))
  assert.ok(!verifyTotp(s, totp(s, now - 120_000), now))
})
