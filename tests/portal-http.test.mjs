import assert from 'node:assert/strict'
import test from 'node:test'
import { startPortal, TOKENS, IDS } from './helpers/portalApp.mjs'

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
