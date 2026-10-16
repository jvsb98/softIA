import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefilter } from './guard.js'

test('bloqueia promessa de rentabilidade', () => {
  assert.equal(prefilter('O retorno é garantido em 12 meses')?.rule, 'rentabilidade')
  assert.equal(prefilter('É um investimento sem risco nenhum')?.rule, 'rentabilidade')
  assert.equal(prefilter('Esse imóvel vai valorizar muito')?.rule, 'rentabilidade')
})

test('bloqueia recomendação personalizada', () => {
  assert.equal(prefilter('Recomendo que você invista 50 mil no Hive SP')?.rule, 'recomendacao')
  assert.equal(prefilter('Para o seu perfil, o ideal é o Hive SP')?.rule, 'recomendacao')
})

test('bloqueia orientação tributária', () => {
  assert.equal(prefilter('Você não precisa declarar no imposto de renda')?.rule, 'juridico_tributario')
  assert.equal(prefilter('Os rendimentos são isentos de imposto')?.rule, 'juridico_tributario')
})

test('permite explicação neutra', () => {
  assert.equal(prefilter('A tokenização divide o imóvel em frações digitais registradas em blockchain.'), null)
  assert.equal(prefilter('A oferta publica uma TIR estimada de 14% ao ano, que não é garantia de resultado.'), null)
})
