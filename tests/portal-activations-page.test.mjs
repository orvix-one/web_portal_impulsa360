import assert from 'node:assert/strict'
import test from 'node:test'
import { SELECT_LISTADO_ACTIVACIONES } from '../server/activacionesListado.js'
import { ACT, TOKENS, startPortal } from './helpers/portalApp.mjs'

async function conPortal(fn) {
  const portal = await startPortal()
  try {
    await fn(portal)
  } finally {
    await portal.close()
  }
}

const json = async (response) => response.json()
const ids = (payload) => payload.activations.map((row) => row.id)

test('/page exige sesion y rol autorizado', () =>
  conPortal(async ({ get }) => {
    assert.equal((await get('/portal/activations/page')).status, 401)
    assert.equal((await get('/portal/activations/page', TOKENS.activador)).status, 401)
  }))

test('/page pagina con total, orden estable y sin firmar fotos ni buscar correos', () =>
  conPortal(async ({ get, supabase }) => {
    const p1 = await json(await get('/portal/activations/page?page=1&pageSize=4', TOKENS.admin))
    assert.deepEqual(ids(p1), [ACT.f1, ACT.f2, ACT.f3, ACT.f4])
    assert.equal(p1.total, 6)
    assert.deepEqual([p1.page, p1.pageSize], [1, 4])

    const p2 = await json(await get('/portal/activations/page?page=2&pageSize=4', TOKENS.admin))
    assert.deepEqual(ids(p2), [ACT.f5, ACT.f6])

    assert.equal(supabase.calls.sign.length, 0, 'el listado no firma fotos')
    assert.ok(!('usuario_email' in p1.activations[0]) && !('foto_url_signed' in p1.activations[0]))
  }))

test('/page devuelve solo las columnas del listado', () =>
  conPortal(async ({ get }) => {
    const { activations } = await json(await get('/portal/activations/page?pageSize=1', TOKENS.admin))
    const columnas = Object.keys(activations[0])
    assert.deepEqual([...columnas].sort(), SELECT_LISTADO_ACTIVACIONES.split(',').sort())
    assert.ok(!columnas.includes('latitud') && !columnas.includes('foto_url') && !columnas.includes('lider_id_registro'))
  }))

test('/page acota pageSize y devuelve vacio fuera de rango con el total', () =>
  conPortal(async ({ get }) => {
    const grande = await json(await get('/portal/activations/page?pageSize=100000', TOKENS.admin))
    assert.equal(grande.pageSize, 100)
    const fuera = await json(await get('/portal/activations/page?page=9&pageSize=4', TOKENS.admin))
    assert.deepEqual(fuera.activations, [])
    assert.equal(fuera.total, 6)
  }))

test('/page aplica filtros en servidor y el total refleja el filtro', () =>
  conPortal(async ({ get }) => {
    const ciudad = await json(await get('/portal/activations/page?plaza=la%20paz', TOKENS.admin))
    assert.deepEqual(ids(ciudad), [ACT.f1, ACT.f3, ACT.f5])
    assert.equal(ciudad.total, 3)

    const sinCiudad = await json(await get('/portal/activations/page?plaza=sin%20ciudad', TOKENS.admin))
    assert.deepEqual(ids(sinCiudad), [ACT.f6])

    const combinado = await json(await get('/portal/activations/page?impulsador=ANA&distrito=centro&fechaDesde=2026-10-03', TOKENS.admin))
    assert.deepEqual(ids(combinado), [ACT.f1])

    const nada = await json(await get('/portal/activations/page?plaza=zzz', TOKENS.admin))
    assert.deepEqual([nada.activations.length, nada.total], [0, 0])
  }))

test('/page: el lider solo ve su alcance, tambien al filtrar', () =>
  conPortal(async ({ get }) => {
    const todo = await json(await get('/portal/activations/page', TOKENS.lider))
    assert.deepEqual(ids(todo), [ACT.f1, ACT.f2, ACT.f5])
    assert.equal(todo.total, 3)
    const filtrado = await json(await get('/portal/activations/page?plaza=oruro', TOKENS.lider))
    assert.deepEqual(filtrado.activations, [], 'f4 (oruro) pertenece a otro lider')
    const sinCiudad = await json(await get('/portal/activations/page?plaza=sin%20ciudad', TOKENS.lider))
    assert.deepEqual(sinCiudad.activations, [], 'f6 (sin ciudad) no es del equipo del lider')
  }))

test('/page responde Server-Timing', () =>
  conPortal(async ({ get }) => {
    const timing = (await get('/portal/activations/page', TOKENS.admin)).headers.get('server-timing') ?? ''
    for (const name of ['auth', 'db', 'total']) assert.match(timing, new RegExp(`${name};dur=`))
  }))

test('/:id devuelve la fila completa con correo y fotos firmadas solo de esa fila', () =>
  conPortal(async ({ get, supabase }) => {
    const { activation } = await json(await get(`/portal/activations/${ACT.f1}`, TOKENS.admin))
    assert.equal(activation.id, ACT.f1)
    assert.equal(activation.usuario_email, 'activador@test.bo')
    assert.match(activation.foto_url_signed, /u1\/a\.jpg/)
    assert.match(activation.foto_cash_in_signed, /u1\/b\.jpg/)
    assert.ok('lider_id_registro' in activation, 'trae todas las columnas')
    assert.equal(supabase.calls.sign.length, 1)
    assert.deepEqual(supabase.calls.sign[0].paths.sort(), ['u1/a.jpg', 'u1/b.jpg'])
  }))

test('/:id valida el identificador, respeta el alcance y reporta inexistentes', () =>
  conPortal(async ({ get }) => {
    assert.equal((await get('/portal/activations/no-es-uuid', TOKENS.admin)).status, 400)
    assert.equal((await get('/portal/activations/b0000000-0000-4000-8000-000000000000', TOKENS.admin)).status, 404)
    assert.equal((await get(`/portal/activations/${ACT.f1}`, TOKENS.lider)).status, 200)
    assert.equal((await get(`/portal/activations/${ACT.f3}`, TOKENS.lider)).status, 404, 'activacion de otro lider')
    assert.equal((await get(`/portal/activations/${ACT.f1}`)).status, 401)
  }))

test('/page y /export-rows no se confunden con /:id', () =>
  conPortal(async ({ get }) => {
    assert.equal((await get('/portal/activations/page', TOKENS.admin)).status, 200)
    assert.equal((await get('/portal/activations/export-rows', TOKENS.admin)).status, 200)
  }))

test('/export-rows devuelve el corte filtrado completo con enlaces de evidencia y sin firmar', () =>
  conPortal(async ({ get, supabase }) => {
    const todo = await json(await get('/portal/activations/export-rows', TOKENS.admin))
    assert.equal(todo.activations.length, 6)
    const f1 = todo.activations.find((row) => row.id === ACT.f1)
    assert.equal(f1.usuario_email, 'activador@test.bo')
    assert.ok(f1.foto_url_evidencia.startsWith(`/evidencia/${ACT.f1}/principal/`))
    assert.ok(f1.foto_cash_in_evidencia.startsWith(`/evidencia/${ACT.f1}/cash-in/`))
    assert.ok('lider_id_registro' in f1)
    assert.equal(supabase.calls.sign.length, 0)

    const filtrado = await json(await get('/portal/activations/export-rows?plaza=la%20paz&fechaDesde=2026-10-03', TOKENS.admin))
    assert.deepEqual(ids(filtrado).sort(), [ACT.f1, ACT.f3].sort())

    const invertido = await json(await get('/portal/activations/export-rows?fechaDesde=2026-10-05&fechaHasta=2026-10-04', TOKENS.admin))
    assert.deepEqual(ids(invertido).sort(), [ACT.f1, ACT.f2].sort(), 'rango invertido se ordena como en la tabla')

    const lider = await json(await get('/portal/activations/export-rows', TOKENS.lider))
    assert.deepEqual(ids(lider).sort(), [ACT.f1, ACT.f2, ACT.f5].sort())
  }))

test('el conteo de /page coincide con las filas del Excel del servidor para los mismos filtros', () =>
  conPortal(async ({ get }) => {
    const query = 'plaza=la%20paz&impulsador=ana&fechaDesde=2026-10-02&fechaHasta=2026-10-05'
    const pagina = await json(await get(`/portal/activations/page?${query}`, TOKENS.admin))
    const excel = await get(`/portal/activations/export-excel?${query}`, TOKENS.admin)
    assert.equal(String(pagina.total), excel.headers.get('x-export-row-count'))
  }))
