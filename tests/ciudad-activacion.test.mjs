import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  ciudadActivacion,
  etiquetaCiudadActivacion,
  SIN_CIUDAD_REGISTRADA,
} from '../src/lib/plazas.js'
import { generateActivacionesExcel } from '../server/activacionesExcel.js'

const componentSource = readFileSync(new URL('../src/components/ActivacionesTable.vue', import.meta.url), 'utf8')
const metricsSource = readFileSync(new URL('../src/components/MetricsDashboard.vue', import.meta.url), 'utf8')
const serverExcelSource = readFileSync(new URL('../server/activacionesExcel.js', import.meta.url), 'utf8')
const plazasSource = readFileSync(new URL('../src/lib/plazas.js', import.meta.url), 'utf8')

test('la ciudad sale de ciudad_activacion y normaliza nombres', () => {
  assert.equal(ciudadActivacion({ ciudad_activacion: 'el_alto' }), 'El Alto')
  assert.equal(ciudadActivacion({ ciudad_activacion: 'la_paz' }), 'La Paz')
  assert.equal(ciudadActivacion({ ciudad_activacion: 'El Alto' }), 'El Alto')
  assert.equal(ciudadActivacion({ ciudad_activacion: ' LA PAZ ' }), 'La Paz')
  assert.equal(ciudadActivacion({ ciudad_activacion: 'el-alto' }), 'El Alto')
  assert.equal(ciudadActivacion('el_alto'), 'El Alto')
})

test('activador de La Paz que activa en El Alto muestra El Alto', () => {
  const fila = {
    ciudad_activacion: 'el_alto',
    plaza_efectiva_registro: 'La Paz',
    plaza_base_registro: 'La Paz',
    plaza: 'La Paz',
  }
  assert.equal(etiquetaCiudadActivacion(fila), 'El Alto')
})

test('activador de El Alto que activa en La Paz muestra La Paz', () => {
  const fila = {
    ciudad_activacion: 'la_paz',
    plaza_efectiva_registro: 'El Alto',
    plaza_base_registro: 'El Alto',
    plaza: 'El Alto',
  }
  assert.equal(etiquetaCiudadActivacion(fila), 'La Paz')
})

test('ciudad NULL o vacía muestra Sin ciudad registrada sin sustituir la plaza', () => {
  for (const ciudad_activacion of [null, undefined, '', '   ', ' ']) {
    const fila = { ciudad_activacion, plaza_efectiva_registro: 'La Paz', plaza: 'La Paz' }
    assert.equal(ciudadActivacion(fila), '', `valor ${JSON.stringify(ciudad_activacion)} no aporta ciudad`)
    assert.equal(etiquetaCiudadActivacion(fila), SIN_CIUDAD_REGISTRADA)
  }
  assert.equal(SIN_CIUDAD_REGISTRADA, 'Sin ciudad registrada')
})

test('la función reutilizable no lee la plaza organizacional ni la legada', () => {
  const inicio = plazasSource.indexOf('export function ciudadActivacion(')
  const fin = plazasSource.indexOf('export function etiquetaCiudadActivacion(')
  const cuerpo = plazasSource.slice(inicio, fin)
  assert.match(cuerpo, /fila\?\.ciudad_activacion/)
  assert.doesNotMatch(cuerpo, /plaza_efectiva_registro|plaza_base_registro|fila\?\.plaza\b/)
})

function fakeSupabase(filas) {
  const query = {
    select() { return query },
    order() { return query },
    gte() { return query },
    lte() { return query },
    async range(from, to) { return { data: filas.slice(from, to + 1), error: null } },
  }
  return { from: () => query }
}

const filtrosVacios = { plaza: '', distrito: '', impulsador: '', fechaDesde: '', fechaHasta: '' }

const filasExcel = [
  { id: 'x1', usuario_id: 'u1', ciudad_activacion: 'el_alto', plaza_efectiva_registro: 'La Paz', plaza_base_registro: 'La Paz', zona_activacion: 'Senkata' },
  { id: 'x2', usuario_id: 'u2', ciudad_activacion: 'la_paz', plaza_efectiva_registro: 'El Alto', plaza_base_registro: 'El Alto', zona_activacion: 'Miraflores' },
  { id: 'x3', usuario_id: 'u3', ciudad_activacion: null, plaza_efectiva_registro: 'La Paz', plaza: 'La Paz', zona_activacion: 'Centro' },
]

async function leerExcel(filters) {
  const result = await generateActivacionesExcel({
    adminSupabase: fakeSupabase(filasExcel),
    bucket: 'activaciones',
    filters: { ...filtrosVacios, ...filters },
  })
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(result.buffer)
  const worksheet = workbook.getWorksheet('Activaciones')
  const encabezados = []
  worksheet.getRow(2).eachCell({ includeEmpty: false }, (cell, index) => { encabezados[index] = cell.value })
  const filas = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= 2) return
    const values = {}
    row.eachCell({ includeEmpty: false }, (cell, index) => { values[encabezados[index]] = cell.value })
    filas.push(values)
  })
  return { result, encabezados: encabezados.filter(Boolean), filas }
}

test('el Excel del servidor separa Ciudad geográfica de Plaza Base y Plaza Efectiva', async () => {
  const { encabezados, filas, result } = await leerExcel({})
  for (const columna of ['Ciudad', 'Distrito', 'Plaza Base', 'Plaza Efectiva']) {
    assert.ok(encabezados.includes(columna), `falta la columna ${columna}`)
  }
  assert.ok(!encabezados.includes('Plaza'), 'la columna unica "Plaza" dejo de mezclar ciudad y plaza')

  assert.equal(result.rowCount, 3)
  assert.deepEqual(filas.map((fila) => [fila.Ciudad, fila['Plaza Efectiva'], fila['Plaza Base']]), [
    ['El Alto', 'La Paz', 'La Paz'],
    ['La Paz', 'El Alto', 'El Alto'],
    [SIN_CIUDAD_REGISTRADA, 'La Paz', ''],
  ])
})

test('el filtro de ciudad del Excel usa la misma semántica que la columna', async () => {
  const porNombre = await leerExcel({ plaza: 'el alto' })
  assert.equal(porNombre.result.rowCount, 1)
  assert.equal(porNombre.filas[0].Ciudad, 'El Alto')

  const porNormalizado = await leerExcel({ plaza: 'el_alto' })
  assert.equal(porNormalizado.result.rowCount, 1)

  const sinCiudad = await leerExcel({ plaza: 'sin ciudad registrada' })
  assert.equal(sinCiudad.result.rowCount, 1)
  assert.equal(sinCiudad.filas[0].Ciudad, SIN_CIUDAD_REGISTRADA)
})

test('el listado, el detalle y las exportaciones del portal usan la misma ciudad', () => {
  const inicioHelper = componentSource.indexOf('function getCiudadActivacion(')
  const finHelper = componentSource.indexOf('\n}', inicioHelper)
  assert.match(componentSource.slice(inicioHelper, finHelper), /etiquetaCiudadActivacion\(activacion\)/)
  assert.doesNotMatch(componentSource.slice(inicioHelper, finHelper), /plaza_efectiva_registro|ciudad_activacion \?\?/)

  const detalle = componentSource.slice(
    componentSource.indexOf('const seccionesDetalleConfig = ['),
    componentSource.indexOf('\n]', componentSource.indexOf('const seccionesDetalleConfig = [')) + 2,
  )
  assert.match(detalle, /keys: \['fecha_activacion', 'impulsador', 'ciudad_activacion', 'plaza', 'zona_activacion'\]/)
  assert.match(detalle, /keys: \['plaza_base_registro', 'plaza_efectiva_registro', 'plaza_temporal_registro'\]/)

  assert.match(componentSource, /key === 'ciudad_activacion'\s*\?\s*etiquetaCiudadActivacion\(row\)/)
  assert.match(componentSource, /filter\(\(key\) => key === 'ciudad_activacion' \|\| tieneValor\(row\[key\]\)/,
    'la ciudad vacía se muestra en el detalle en lugar de omitirse')

  const columnasCsv = componentSource.match(/const columnasExportacion = \[([\s\S]*?)\n\]/)?.[1] ?? ''
  assert.match(columnasCsv, /\['Ciudad', \(row\) => getCiudadActivacion\(row\)\]/)
  assert.match(columnasCsv, /\['Plaza Base', \(row\) => row\.plaza_base_registro\]/)
  assert.match(columnasCsv, /\['Plaza Efectiva', \(row\) => row\.plaza_efectiva_registro\]/)

  const columnasExcel = componentSource.match(/const columnasExcelPersonalizado = \[([\s\S]*?)\n\]/)?.[1] ?? ''
  assert.match(columnasExcel, /\['Ciudad', \(row\) => etiquetaCiudadActivacion\(row\)\]/)
  assert.doesNotMatch(columnasExcel, /plaza_efectiva_registro/)
})

test('el dashboard calcula la ciudad solo desde ciudad_activacion', () => {
  const inicio = metricsSource.indexOf('function plazaTextoBruto(')
  const fin = metricsSource.indexOf('function plazaEtiqueta(', inicio)
  const cuerpo = metricsSource.slice(inicio, fin)
  assert.match(cuerpo, /return ciudadActivacion\(item\)/)
  assert.doesNotMatch(cuerpo, /plaza_efectiva_registro|plaza_base_registro|texto\(item\.plaza\)/)
  assert.match(metricsSource, /function plazaRegistro\(item\) \{ return etiquetaCiudadActivacion\(item\) \}/)
  assert.match(metricsSource, /return SIN_CIUDAD_REGISTRADA/)
  assert.doesNotMatch(metricsSource, /pid:/, 'la ciudad no se resuelve por el UUID de la plaza organizacional')
})

test('el Excel del servidor filtra y exporta con la misma función de ciudad', () => {
  assert.match(serverExcelSource, /mismaCiudad\(etiquetaCiudadActivacion\(row\), filters\.plaza\)/)
  assert.match(serverExcelSource, /normalizarPlazaClave\(value\)\.includes\(normalizarPlazaClave\(search\)\)/)
  assert.match(serverExcelSource, /ciudad: etiquetaCiudadActivacion\(row\)/)
  assert.match(serverExcelSource, /\['Ciudad', 'ciudad', \d+\]/)
  assert.match(serverExcelSource, /\['Plaza Base', 'plazaBase', \d+\]/)
  assert.match(serverExcelSource, /\['Plaza Efectiva', 'plazaEfectiva', \d+\]/)
  assert.doesNotMatch(serverExcelSource, /getCiudad|plaza_efectiva_registro \?\? row\.ciudad_activacion/)
})

test('el filtro del listado normaliza la ciudad igual que la exportación', () => {
  // El filtro vive en el servidor (listado paginado); el navegador ya no filtra filas.
  const filtros = readFileSync(new URL('../server/activacionesFiltros.js', import.meta.url), 'utf8')
  const inicio = filtros.indexOf('export function ciudadesQueCoinciden(')
  const cuerpo = filtros.slice(inicio, filtros.indexOf('\n}', inicio))
  assert.match(cuerpo, /const clave = normalizarPlazaClave\(consulta\)/)
  assert.match(cuerpo, /normalizarPlazaClave\(etiquetaCiudadActivacion\(\{ ciudad_activacion: crudo \}\)\)\.includes\(clave\)/)
  assert.doesNotMatch(cuerpo, /plaza_efectiva_registro/)
  assert.doesNotMatch(componentSource, /const activacionesFiltradas = computed\(/, 'la tabla no filtra en el navegador')
})

test('el filtro de ciudad une las plazas activas aunque no tengan activaciones', () => {
  assert.match(metricsSource, /portalRequest\('\/portal\/plazas'\)/)
  const inicio = metricsSource.indexOf('for (const plaza of plazasCatalogo.value)')
  const cuerpo = metricsSource.slice(inicio, metricsSource.indexOf('}\n', inicio + 200))
  assert.match(cuerpo, /`pkey:\$\{clave\}`/)
  assert.match(cuerpo, /plazas\.set\(key, \{ key, nombre \}\)/)
  assert.match(cuerpo, /!plazas\.has\(key\)/)
})
