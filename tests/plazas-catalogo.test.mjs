import assert from 'node:assert/strict'
import test from 'node:test'
import { parsearAliasesPlaza } from '../src/lib/plazas.js'

test('aliases: separa por coma, recorta y elimina variantes equivalentes', () => {
  assert.deepEqual(parsearAliasesPlaza(' Concepción, concepcion , , Vaca Díez'), ['Concepción', 'Vaca Díez'])
})

test('aliases: acepta arreglos e ignora valores que no son texto', () => {
  assert.deepEqual(parsearAliasesPlaza(['Santa Cruz', null, 7]), ['Santa Cruz'])
  assert.deepEqual(parsearAliasesPlaza(undefined), [])
})
