import assert from 'node:assert/strict'
import { test } from 'node:test'
import { q } from './db.js'
import { ctxKey, NoContextError, schemaForSlug, withPlatform, withTenant, type TenantCtx } from './tenant.js'
import { normalizeHost, validateSlug } from '../platform/tenants.js'

const T: TenantCtx = { kind: 'tenant', id: '11111111-1111-1111-1111-111111111111', slug: 'clinica-x', schema: 't_clinica_x', name: 'Clínica X', status: 'ativo' }

test('schema do cliente vem do slug e só aceita caracteres seguros', () => {
  assert.equal(schemaForSlug('clinica-x'), 't_clinica_x')
  assert.throws(() => schemaForSlug('a"; drop schema public; --'))
})

test('slugs reservados e inválidos são recusados', () => {
  assert.equal(validateSlug('marmoraria-alfa'), null)
  assert.match(validateSlug('painel') ?? '', /reservado/)
  assert.ok(validateSlug('-abc'))
  assert.ok(validateSlug('ABC'))
})

test('hostname é normalizado (caixa, porta, ponto final)', () => {
  assert.equal(normalizeHost('Clinica.Exemplo.com.'), 'clinica.exemplo.com')
  assert.equal(normalizeHost('alfa.localhost:8080'), 'alfa.localhost')
})

test('chave de cache e salas levam o prefixo do contexto', () => {
  assert.equal(withTenant(T, () => ctxKey()), `t:${T.id}:`)
  assert.equal(withPlatform(() => ctxKey()), 'p:')
  assert.throws(() => ctxKey(), NoContextError)
})

test('consulta fora de um contexto falha antes de tocar no banco', async () => {
  await assert.rejects(() => q('SELECT 1'), NoContextError)
})
