import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeScore, type Criterion } from './qualification.js'

const crit = (c: Partial<Criterion>): Criterion => ({ id: c.key!, label: c.key!, question: '', description: '', weight: 1, required: true, disqualify_values: [], sort: 0, options: [], type: 'choice', ...c }) as Criterion

test('score determinístico com faixas e pesos', () => {
  const criteria = [
    crit({ key: 'experiencia', type: 'choice', options: [{ value: 'renda_fixa', label: 'RF', points: 5 }, { value: 'imoveis', label: 'Imóveis', points: 10 }] }),
    crit({ key: 'valor', type: 'number', weight: 2, options: [{ min: 0, max: 9999, points: 1 }, { min: 10000, max: null, points: 6 }] }),
    crit({ key: 'prazo', type: 'choice', options: [{ value: 'agora', label: 'Agora', points: 8 }], disqualify_values: ['nunca'] }),
  ]
  const r = computeScore(criteria, { experiencia: 'imoveis', valor: 50000 })
  assert.equal(r.total, 10 + 12)
  assert.deepEqual(r.missing.map((m) => m.key), ['prazo'])
  assert.equal(computeScore(criteria, { prazo: 'nunca' }).disqualifiedBy, null) // valor inexistente nas opções: ignorado
})
