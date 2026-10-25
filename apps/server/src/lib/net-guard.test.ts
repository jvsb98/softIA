import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSafeUrl } from './net-guard.js'

test('bloqueia metadados da nuvem e protocolos estranhos', async () => {
  await assert.rejects(assertSafeUrl('http://169.254.169.254/metadata/v1/'))
  await assert.rejects(assertSafeUrl('http://[::ffff:169.254.169.254]/'))
  await assert.rejects(assertSafeUrl('http://0.0.0.0:8080/'))
  await assert.rejects(assertSafeUrl('file:///etc/passwd'))
  await assert.rejects(assertSafeUrl('http://metadata.google.internal/'))
})

test('SaaS: bloqueia a rede interna por padrão', async () => {
  delete process.env.NET_GUARD_ALLOW_PRIVATE
  await assert.rejects(assertSafeUrl('http://192.168.0.20:5678/webhook/x'))
  await assert.rejects(assertSafeUrl('http://10.0.0.5/api'))
  await assert.rejects(assertSafeUrl('http://127.0.0.1:8080/api/health'))
  await assert.rejects(assertSafeUrl('http://172.17.0.2:5432/'))
  await assert.rejects(assertSafeUrl('http://[::1]:8080/'))
  await assertSafeUrl('http://93.184.216.34/')
})

test('instalação de um cliente só: intranet liberada com NET_GUARD_ALLOW_PRIVATE', async () => {
  process.env.NET_GUARD_ALLOW_PRIVATE = 'true'
  try {
    await assertSafeUrl('http://192.168.0.20:5678/webhook/x')
    await assertSafeUrl('http://10.0.0.5/api')
    await assert.rejects(assertSafeUrl('http://169.254.169.254/metadata/v1/'))
  } finally {
    delete process.env.NET_GUARD_ALLOW_PRIVATE
  }
})
