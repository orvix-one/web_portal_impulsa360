import assert from 'node:assert/strict'
import test from 'node:test'
import { startPortal, TOKENS, IDS } from './helpers/portalApp.mjs'

// Red de seguridad HTTP: fija el contrato actual de /portal/* antes de refactorizar.

async function conPortal(fn, tables) {
  const portal = await startPortal(tables)
  try {
    await fn(portal)
  } finally {
    await portal.close()
  }
}

test('auth: sin token, token invalido, perfil inactivo y activador raso reciben 401', () =>
  conPortal(async ({ get }) => {
    assert.equal((await get('/portal/plazas')).status, 401)
    assert.equal((await get('/portal/plazas', 'tok-falso')).status, 401)
    assert.equal((await get('/portal/plazas', TOKENS.inactivo)).status, 401)
    assert.equal((await get('/portal/plazas', TOKENS.activador)).status, 401)
  }))

test('auth: administrador, lider y banco acceden a /portal', () =>
  conPortal(async ({ get }) => {
    for (const token of [TOKENS.admin, TOKENS.lider, TOKENS.banco]) {
      const response = await get('/portal/plazas', token)
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()).plazas, [{ id: 'p1', nombre: 'La Paz' }])
    }
  }))

test('GET /portal/me devuelve el perfil sin auth_user_id y con roles', () =>
  conPortal(async ({ get }) => {
    const { profile } = await (await get('/portal/me', TOKENS.lider)).json()
    assert.equal(profile.usuario_id, IDS.lider)
    assert.ok(!('auth_user_id' in profile))
    assert.deepEqual(profile.roles, ['lider'])
  }))

test('GET /portal/activations: admin ve todo, ordenado por created_at DESC e id ASC', () =>
  conPortal(async ({ get }) => {
    const { activations } = await (await get('/portal/activations?from=0&to=999', TOKENS.admin)).json()
    assert.deepEqual(
      activations.map((row) => row.id),
      ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
    )
  }))

test('GET /portal/activations: respeta from/to', () =>
  conPortal(async ({ get }) => {
    const { activations } = await (await get('/portal/activations?from=1&to=2', TOKENS.admin)).json()
    assert.deepEqual(
      activations.map((row) => row.id),
      ['f2', 'f3'],
    )
  }))

test('GET /portal/activations: el lider ve su historico y los nulos de su equipo actual', () =>
  conPortal(async ({ get }) => {
    const { activations } = await (await get('/portal/activations?from=0&to=999', TOKENS.lider)).json()
    assert.deepEqual(
      activations.map((row) => row.id),
      ['f1', 'f2', 'f5'],
    )
  }))

test('GET /portal/activations: agrega usuario_email y campos de foto firmada/evidencia', () =>
  conPortal(async ({ get, supabase }) => {
    const { activations } = await (await get('/portal/activations?from=0&to=999', TOKENS.admin)).json()
    const f1 = activations.find((row) => row.id === 'f1')
    assert.equal(f1.usuario_email, 'activador@test.bo')
    assert.match(f1.foto_url_signed, /^https:\/\/signed\.test\/fotos-activaciones\/u1\/a\.jpg/)
    assert.match(f1.foto_cash_in_signed, /u1\/b\.jpg/)
    assert.match(f1.foto_url_evidencia, /^\/evidencia\/f1\/principal\//)
    const f3 = activations.find((row) => row.id === 'f3')
    assert.equal(f3.foto_url_signed, null)
    assert.equal(f3.foto_url_evidencia, null)
    assert.equal(supabase.calls.sign.length, 1, 'firma en un solo lote (<=100 rutas)')
  }))

test('GET /portal/activations: responde Server-Timing con auth, db, email, sign y total', () =>
  conPortal(async ({ get }) => {
    const response = await get('/portal/activations?from=0&to=999', TOKENS.admin)
    const timing = response.headers.get('server-timing') ?? ''
    for (const name of ['auth', 'db', 'email', 'sign', 'total']) assert.match(timing, new RegExp(`${name};dur=\\d`))
  }))

test('GET /portal/activations/export-excel: cuenta filas segun alcance y filtros', () =>
  conPortal(async ({ get }) => {
    const admin = await get('/portal/activations/export-excel', TOKENS.admin)
    assert.equal(admin.status, 200)
    assert.equal(admin.headers.get('x-export-row-count'), '6')
    assert.equal(admin.headers.get('x-export-version'), 'links-v2')

    const lider = await get('/portal/activations/export-excel', TOKENS.lider)
    assert.equal(lider.headers.get('x-export-row-count'), '3')

    const filtrado = await get('/portal/activations/export-excel?fechaDesde=2026-10-04&fechaHasta=2026-10-05', TOKENS.admin)
    assert.equal(filtrado.headers.get('x-export-row-count'), '2')

    const porCiudad = await get('/portal/activations/export-excel?plaza=la%20paz', TOKENS.admin)
    assert.equal(porCiudad.headers.get('x-export-row-count'), '3')
  }))

test('GET /portal/users: el lider solo ve a su equipo', () =>
  conPortal(async ({ get }) => {
    const { users } = await (await get('/portal/users', TOKENS.lider)).json()
    assert.deepEqual(
      users.map((user) => user.usuario_id),
      [IDS.activador],
    )
  }))
