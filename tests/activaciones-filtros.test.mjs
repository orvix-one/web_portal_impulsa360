import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aplicarFiltrosActivaciones,
  ciudadesQueCoinciden,
  crearCatalogoCiudades,
  escaparLike,
  normalizarFiltros,
  resolverCiudadesFiltro,
} from '../server/activacionesFiltros.js'
import { parsearPagina } from '../server/activacionesListado.js'
import { etiquetaCiudadActivacion, normalizarPlazaClave } from '../src/lib/plazas.js'
import { createFakeSupabase } from './helpers/fakeSupabase.mjs'

const vacios = { plaza: '', distrito: '', impulsador: '', fechaDesde: '', fechaHasta: '' }

test('normalizarFiltros: recorta, deja solo fecha y ordena un rango invertido', () => {
  assert.deepEqual(normalizarFiltros({ plaza: ' La Paz ', fechaDesde: '2026-10-09T10:00:00Z', fechaHasta: '2026-10-01' }), {
    ...vacios,
    plaza: 'La Paz',
    fechaDesde: '2026-10-01',
    fechaHasta: '2026-10-09',
  })
  assert.deepEqual(normalizarFiltros({ fechaDesde: 'no-es-fecha', impulsador: 5 }), vacios)
})

test('escaparLike neutraliza comodines de LIKE', () => {
  assert.equal(escaparLike('50%_off\\'), '50\\%\\_off\\\\')
})

test('parsearPagina acota page y pageSize', () => {
  assert.deepEqual(parsearPagina({}), { page: 1, pageSize: 50 })
  assert.deepEqual(parsearPagina({ page: '3', pageSize: '20' }), { page: 3, pageSize: 20 })
  assert.deepEqual(parsearPagina({ page: '-4', pageSize: '9999' }), { page: 1, pageSize: 100 })
  assert.deepEqual(parsearPagina({ page: 'x', pageSize: '0' }), { page: 1, pageSize: 50 })
})

// Oraculo: la regla que aplicaba el navegador.
const normalizeText = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
function filtroNavegador(rows, f) {
  const plaza = normalizarPlazaClave(f.plaza)
  const distrito = normalizeText(f.distrito)
  const impulsador = normalizeText(f.impulsador)
  return rows.filter((row) => {
    const fecha = String(row.fecha_activacion ?? '').slice(0, 10)
    return (
      (!plaza || normalizarPlazaClave(etiquetaCiudadActivacion(row)).includes(plaza)) &&
      (!distrito || normalizeText(row.zona_activacion).includes(distrito)) &&
      (!impulsador || normalizeText(row.impulsador).includes(impulsador)) &&
      (!f.fechaDesde || (fecha && fecha >= f.fechaDesde)) &&
      (!f.fechaHasta || (fecha && fecha <= f.fechaHasta))
    )
  })
}

const filas = [
  { id: 1, ciudad_activacion: 'la_paz', zona_activacion: 'Centro', impulsador: 'Ana Pérez', fecha_activacion: '2026-10-05' },
  { id: 2, ciudad_activacion: 'La Paz', zona_activacion: 'Sopocachi', impulsador: 'ana pérez', fecha_activacion: '2026-10-04' },
  { id: 3, ciudad_activacion: 'el-alto', zona_activacion: 'Ciudad Satélite', impulsador: 'Beto', fecha_activacion: '2026-10-03' },
  { id: 4, ciudad_activacion: 'santa cruz', zona_activacion: '100%_zona', impulsador: 'Carla', fecha_activacion: '2026-10-02' },
  { id: 5, ciudad_activacion: null, zona_activacion: null, impulsador: 'Diego', fecha_activacion: '2026-10-01' },
  { id: 6, ciudad_activacion: '', zona_activacion: 'Centro', impulsador: 'Eva', fecha_activacion: '2026-09-30' },
  { id: 7, ciudad_activacion: 'Ciudad "Rara", (x)', zona_activacion: 'Norte', impulsador: 'Fer', fecha_activacion: '2026-09-29' },
]

async function filtroServidor(entrada) {
  const filtros = normalizarFiltros(entrada)
  const supabase = createFakeSupabase({ tables: { activaciones: filas } })
  const ciudades = await resolverCiudadesFiltro(crearCatalogoCiudades(supabase), filtros)
  const query = aplicarFiltrosActivaciones(supabase.from('activaciones').select('*'), filtros, ciudades)
  if (!query) return []
  return (await query).data.map((row) => row.id)
}

test('el filtro en servidor devuelve las mismas filas que el filtro del navegador', async () => {
  const casos = [
    {},
    { plaza: 'la paz' },
    { plaza: 'LA_PAZ' },
    { plaza: 'alto' },
    { plaza: 'sin ciudad registrada' },
    { plaza: 'sin ciudad' },
    { plaza: 'rara' },
    { plaza: 'inexistente' },
    { distrito: 'centro' },
    { distrito: '%' },
    { distrito: '100%' },
    { impulsador: 'ANA' },
    { fechaDesde: '2026-10-02', fechaHasta: '2026-10-04' },
    { fechaDesde: '2026-10-04', fechaHasta: '2026-10-02' },
    { plaza: 'la paz', distrito: 'centro', impulsador: 'ana', fechaDesde: '2026-10-05' },
  ]
  for (const caso of casos) {
    const esperado = filtroNavegador(filas, normalizarFiltros(caso)).map((row) => row.id)
    assert.deepEqual(await filtroServidor(caso), esperado, JSON.stringify(caso))
  }
})

test('ciudadesQueCoinciden: null sin consulta y sin coincidencias devuelve conjunto vacio', () => {
  assert.equal(ciudadesQueCoinciden(['la_paz'], ''), null)
  assert.deepEqual(ciudadesQueCoinciden(['la_paz'], 'zzz'), { valores: [], incluirNulos: false })
})

test('el catalogo de ciudades se consulta una vez dentro del TTL y se refresca despues', async () => {
  const supabase = createFakeSupabase({ tables: { activaciones: filas } })
  let ahora = 0
  const obtener = crearCatalogoCiudades(supabase, { ttlMs: 1000, now: () => ahora })
  const [a, b] = await Promise.all([obtener(), obtener()])
  assert.deepEqual(a, b)
  assert.equal(supabase.calls.from.length, 1, 'consultas en vuelo se comparten')
  await obtener()
  assert.equal(supabase.calls.from.length, 1, 'dentro del TTL no consulta')
  ahora = 2000
  await obtener()
  assert.equal(supabase.calls.from.length, 2, 'vencido el TTL vuelve a consultar')
})
