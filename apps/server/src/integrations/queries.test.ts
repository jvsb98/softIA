import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileParams, guardSql, maskValue, shapeRows } from './queries.js'

test('converte parâmetros nomeados por driver', () => {
  const sql = "SELECT * FROM t WHERE cpf = :cpf AND status = 'ativo:x' AND criado::date > :desde"
  assert.equal(compileParams(sql, 'postgres', { cpf: '1', desde: '2026-01-01' }).sql, "SELECT * FROM t WHERE cpf = $1 AND status = 'ativo:x' AND criado::date > $2")
  assert.equal(compileParams(sql, 'mysql', {}).sql, "SELECT * FROM t WHERE cpf = ? AND status = 'ativo:x' AND criado::date > ?")
  assert.equal(compileParams(sql, 'mssql', {}).sql, "SELECT * FROM t WHERE cpf = @cpf AND status = 'ativo:x' AND criado::date > @desde")
})

test('guarda de SQL só permite leitura', () => {
  assert.equal(guardSql('SELECT 1'), null)
  assert.equal(guardSql('WITH x AS (SELECT 1) SELECT * FROM x'), null)
  assert.ok(guardSql('DELETE FROM t'))
  assert.ok(guardSql('SELECT 1; DROP TABLE t'))
  assert.ok(guardSql('SELECT * FROM t -- comentário'))
  assert.ok(guardSql('SELECT pg_sleep(10)'))
  assert.equal(guardSql("SELECT 'update' AS palavra"), null)
})

test('máscaras e campos permitidos', () => {
  assert.equal(maskValue('cpf', '12345678909'), '***.456.789-**')
  assert.equal(maskValue('email', 'joao@nimber.com.br'), 'j***@nimber.com.br')
  const rows = shapeRows([{ nome: 'Ana', cpf: '12345678909', saldo: 10, interno: 'x' }], { output_fields: ['nome', 'cpf', 'saldo'], masks: { cpf: 'cpf' }, max_rows: 5 })
  assert.deepEqual(rows, [{ nome: 'Ana', cpf: '***.456.789-**', saldo: 10 }])
})
