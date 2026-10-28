import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SELECT_LISTADO_ACTIVACIONES } from '../server/activacionesListado.js'
import { SELECT_METRICAS_ACTIVACIONES } from '../server/metricasActivaciones.js'

const doc = readFileSync(new URL('../docs/esquema-remoto.md', import.meta.url), 'utf8')

function columnasDocumentadas(tabla) {
  const inicio = doc.indexOf(`## ${tabla}\n`)
  assert.ok(inicio >= 0, `${tabla} no esta documentada`)
  const fin = doc.indexOf('\n## ', inicio + 1)
  const seccion = doc.slice(inicio, fin > 0 ? fin : undefined)
  return new Set([...seccion.matchAll(/^\| (\w+) \|/gm)].map((fila) => fila[1]))
}

test('las columnas pedidas a activaciones existen en el esquema remoto documentado', () => {
  const existentes = columnasDocumentadas('activaciones')
  assert.ok(existentes.size > 50)
  for (const [nombre, lista] of [
    ['SELECT_LISTADO_ACTIVACIONES', SELECT_LISTADO_ACTIVACIONES],
    ['SELECT_METRICAS_ACTIVACIONES', SELECT_METRICAS_ACTIVACIONES],
  ]) {
    for (const columna of lista.split(',')) assert.ok(existentes.has(columna), `${nombre}: ${columna} no existe en docs/esquema-remoto.md`)
  }
})
