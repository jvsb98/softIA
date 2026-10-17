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

test('permite intranet e internet', async () => {
  await assertSafeUrl('http://192.168.0.20:5678/webhook/x')
  await assertSafeUrl('http://10.0.0.5/api')
  await assertSafeUrl('http://127.0.0.1:8080/api/health')
})
