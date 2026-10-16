import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkText, htmlToText } from './kb.js'

test('divide texto por títulos e tamanho', () => {
  const text = `# Tokenização\n\n${'A tokenização divide o ativo em frações. '.repeat(40)}\n\n# Hive SP\n\nResidencial estudantil próximo à USP.`
  const chunks = chunkText(text, 400)
  assert.ok(chunks.length >= 3)
  assert.equal(chunks[0]!.heading, 'Tokenização')
  assert.equal(chunks[chunks.length - 1]!.heading, 'Hive SP')
})

test('converte HTML em texto legível', () => {
  const t = htmlToText('<html><script>x()</script><h2>Como funciona</h2><p>Frações &amp; tokens</p></html>')
  assert.ok(t.includes('## Como funciona'))
  assert.ok(t.includes('Frações & tokens'))
  assert.ok(!t.includes('x()'))
})
