import assert from 'node:assert/strict'
import test from 'node:test'
import { cargarActivacionesMetricas, ejecutarConConcurrencia } from '../server/metricasActivaciones.js'
import { ACT, TOKENS, startPortal } from './helpers/portalApp.mjs'

async function conPortal(fn, { tables, appOptions } = {}) {
  const portal = await startPortal(tables, appOptions)
  try {
    await fn(portal)
  } finally {
    await portal.close()
  }
}

const json = async (response) => response.json()
const ids = (payload) => payload.activations.map((row) => row.id)

const COLUMNAS_TABLERO = [
  'id',
  'usuario_id',
  'fecha_activacion',
  'created_at',
  'ciudad_activacion',
  'impulsador',
  'tipo_activacion',
  'tipo_comercio',
  'tipo_tienda',
  'lider_id_registro',
  'lider_nombre_registro',
  'equipo_id_registro',
  'equipo_numero_registro',
  'equipo_nombre_registro',
  'nombres_cliente',
  'cash_in',
  'hubo_error',
  'latitud',
  'longitud',
]

test('/metrics/activations exige sesion y rol autorizado', () =>
  conPortal(async ({ get }) => {
    assert.equal((await get('/portal/metrics/activations')).status, 401)
    assert.equal((await get('/portal/metrics/activations', TOKENS.activador)).status, 401)
    assert.equal((await get('/portal/metrics/activations', TOKENS.banco)).status, 200)
  }))

test('/metrics/activations devuelve todas las filas en el orden estable del listado', () =>
  conPortal(async ({ get }) => {
    const payload = await json(await get('/portal/metrics/activations', TOKENS.admin))
    assert.deepEqual(ids(payload), [ACT.f1, ACT.f2, ACT.f3, ACT.f4, ACT.f5, ACT.f6])
    assert.ok(Number.isFinite(Date.parse(payload.generatedAt)))
    const listado = await json(await get('/portal/activations/page?pageSize=100', TOKENS.admin))
    assert.deepEqual(ids(payload), ids(listado), 'mismo orden que el listado paginado')
  }))

test('/metrics/activations devuelve solo las columnas del tablero, sin correos ni fotos, y no firma nada', () =>
  conPortal(async ({ get, supabase }) => {
    const { activations } = await json(await get('/portal/metrics/activations', TOKENS.admin))
    const columnas = new Set(activations.flatMap((row) => Object.keys(row)))
    for (const columna of columnas) assert.ok(COLUMNAS_TABLERO.includes(columna), `columna inesperada: ${columna}`)
    for (const columna of ['id', 'usuario_id', 'lider_id_registro', 'ciudad_activacion', 'impulsador']) assert.ok(columnas.has(columna))
    for (const prohibida of ['usuario_email', 'foto_url', 'foto_url_signed', 'foto_cash_in', 'telefono_cliente', 'ci_cliente']) {
      assert.ok(!columnas.has(prohibida), `no debe incluir ${prohibida}`)
    }
    assert.equal(supabase.calls.sign.length, 0)
  }))

test('/metrics/activations: el lider recibe exactamente su alcance, igual que el listado y la exportacion', () =>
  conPortal(async ({ get }) => {
    const metricas = await json(await get('/portal/metrics/activations', TOKENS.lider))
    assert.deepEqual(ids(metricas), [ACT.f1, ACT.f2, ACT.f5])
    const listado = await json(await get('/portal/activations/page', TOKENS.lider))
    const exportacion = await json(await get('/portal/activations/export-rows', TOKENS.lider))
    assert.deepEqual(ids(metricas).sort(), ids(listado).sort())
    assert.deepEqual(ids(metricas).sort(), ids(exportacion).sort())
  }))

test('/metrics/activations responde Server-Timing y no se cachea', () =>
  conPortal(async ({ get }) => {
    const response = await get('/portal/metrics/activations', TOKENS.admin)
    const timing = response.headers.get('server-timing') ?? ''
    for (const name of ['auth', 'db', 'total']) assert.match(timing, new RegExp(`${name};dur=`))
    assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  }))

test('/metrics/activations concatena varias paginas sin duplicar ni omitir, con empates en created_at', () =>
  conPortal(
    async ({ get, supabase }) => {
      const { activations } = await json(await get('/portal/metrics/activations', TOKENS.admin))
      assert.deepEqual(
        activations.map((row) => row.id),
        [ACT.f1, ACT.f2, ACT.f3, ACT.f4, ACT.f5, ACT.f6],
      )
      const paginas = supabase.calls.range.filter(([tabla]) => tabla === 'activaciones')
      assert.ok(paginas.length >= 3, 'pidio varias paginas de 2 filas')
      const lider = await json(await get('/portal/metrics/activations', TOKENS.lider))
      assert.deepEqual(ids(lider), [ACT.f1, ACT.f2, ACT.f5])
    },
    { appOptions: { metricsPageSize: 2 } },
  ))

test('ejecutarConConcurrencia respeta el limite y conserva el orden de resultados', async () => {
  let enVuelo = 0
  let maximo = 0
  const tareas = Array.from({ length: 10 }, (_, i) => async () => {
    enVuelo += 1
    maximo = Math.max(maximo, enVuelo)
    await new Promise((resolve) => setTimeout(resolve, 5 + (i % 3)))
    enVuelo -= 1
    return i
  })
  const resultados = await ejecutarConConcurrencia(tareas, 3)
  assert.deepEqual(resultados, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(maximo, 3)
  assert.deepEqual(await ejecutarConConcurrencia([], 4), [])
})

function consultaFalsa(filas, { alFallar } = {}) {
  const llamadas = []
  const construirConsulta = (_select, options) => {
    const consulta = {
      order: () => consulta,
      range(desde, hasta) {
        llamadas.push([desde, hasta, Boolean(options?.count)])
        return Promise.resolve(alFallar?.(desde) ?? { data: filas.slice(desde, hasta + 1), count: filas.length, error: null })
      },
    }
    return consulta
  }
  return { construirConsulta, llamadas }
}

test('cargarActivacionesMetricas: una sola pagina no pide mas, el total solo viaja en la primera', async () => {
  const filas = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const { construirConsulta, llamadas } = consultaFalsa(filas)
  assert.deepEqual(await cargarActivacionesMetricas({ construirConsulta, pageSize: 5 }), filas)
  assert.deepEqual(llamadas, [[0, 4, true]])
})

test('cargarActivacionesMetricas: varias paginas, descarta repetidos por desplazamiento y tolera paginas fuera de rango', async () => {
  const filas = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const { construirConsulta, llamadas } = consultaFalsa(filas, {
    alFallar: (desde) => {
      if (desde === 2) return { data: [{ id: 'b' }, { id: 'c' }], count: 5, error: null }
      if (desde === 4) return { data: null, count: null, error: { code: 'PGRST103' } }
      return undefined
    },
  })
  const resultado = await cargarActivacionesMetricas({ construirConsulta, pageSize: 2 })
  assert.deepEqual(
    resultado.map((fila) => fila.id),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    llamadas.map(([desde, , conteo]) => [desde, conteo]),
    [
      [0, true],
      [2, false],
      [4, false],
    ],
  )
})

test('cargarActivacionesMetricas: alcance sin autorizacion devuelve vacio y los errores se propagan', async () => {
  assert.deepEqual(await cargarActivacionesMetricas({ construirConsulta: () => null }), [])
  const { construirConsulta } = consultaFalsa([], { alFallar: () => ({ data: null, count: null, error: new Error('boom') }) })
  await assert.rejects(() => cargarActivacionesMetricas({ construirConsulta }), /boom/)
})
