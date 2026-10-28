import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { aplicarAlcanceLider, esUuid, expresionAlcanceLider } from '../server/alcanceLider.js'
import { generateActivacionesExcel } from '../server/activacionesExcel.js'

const lider = '10000000-0000-0000-0000-000000000001'
const liderAjeno = '10000000-0000-0000-0000-000000000009'
const integrante = '20000000-0000-0000-0000-000000000001'
const ajeno = '20000000-0000-0000-0000-000000000002'

const filtrosVacios = { plaza: '', distrito: '', impulsador: '', fechaDesde: '', fechaHasta: '' }

const filasBase = [
  { id: 'f1', usuario_id: integrante, lider_id_registro: lider },
  { id: 'f2', usuario_id: ajeno, lider_id_registro: lider },
  { id: 'f3', usuario_id: integrante, lider_id_registro: liderAjeno },
  { id: 'f4', usuario_id: ajeno, lider_id_registro: liderAjeno },
  { id: 'f5', usuario_id: integrante, lider_id_registro: null },
  { id: 'f6', usuario_id: ajeno, lider_id_registro: null },
]

function evaluarExpresion(filas, expresion) {
  if (!expresion) return []
  const historico = expresion.match(/lider_id_registro\.eq\.([0-9a-f-]+)/i)?.[1] ?? ''
  const equipoTexto = expresion.match(/and\(lider_id_registro\.is\.null,usuario_id\.in\.\(([^)]*)\)\)/)?.[1] ?? ''
  const equipo = equipoTexto.split(',').filter(Boolean)
  return filas.filter((row) => {
    if (historico && String(row.lider_id_registro) === historico) return true
    return (row.lider_id_registro === null || row.lider_id_registro === undefined) && equipo.includes(String(row.usuario_id))
  })
}

function idsAutorizados(userIds, liderId) {
  return evaluarExpresion(filasBase, expresionAlcanceLider(userIds, liderId)).map((row) => row.id)
}

test('el lider_id_registro con valor autoriza exclusivamente al lider registrado', () => {
  assert.equal(
    expresionAlcanceLider([integrante, ajeno], lider),
    `lider_id_registro.eq.${lider},and(lider_id_registro.is.null,usuario_id.in.(${integrante},${ajeno}))`,
  )
  assert.equal(expresionAlcanceLider([], lider), `lider_id_registro.eq.${lider}`)
  assert.equal(expresionAlcanceLider([integrante], 'no-uuid'), '', 'sin lider valido no hay alcance')
  assert.ok(esUuid(integrante) && !esUuid('no-uuid') && !esUuid(null))
})

test('el equipo actual nunca autoriza sobre filas con snapshot de otro lider', () => {
  const conEquipo = expresionAlcanceLider([integrante, ajeno], lider)
  assert.ok(conEquipo.startsWith('lider_id_registro.eq.'), 'la parte historica encabeza la expresion')
  assert.equal((conEquipo.match(/usuario_id\.in\./g) ?? []).length, 1)
  assert.ok(
    conEquipo.includes('and(lider_id_registro.is.null,usuario_id.in.'),
    'el IN de equipo vive solo dentro de and(lider_id_registro.is.null, ...)',
  )
  assert.ok(!conEquipo.startsWith('usuario_id.in.'), 'el equipo actual no autoriza por si solo')
  assert.ok(conEquipo.includes('lider_id_registro.is.null'), 'la pertenencia actual aplica unicamente a snapshots nulos')
  assert.ok(!conEquipo.includes('estado'), 'el estado del perfil no participa en el alcance')
})

test('aplicarAlcanceLider consulta la expresion o deniega cuando no hay alcance', () => {
  const aplicaciones = []
  const query = {
    or(expr) {
      aplicaciones.push(expr)
      return query
    },
  }

  assert.equal(aplicarAlcanceLider(query, null), query)
  assert.equal(aplicaciones.length, 0, 'el rol sin alcance (admin) mantiene acceso completo')

  assert.equal(aplicarAlcanceLider(query, { userIds: [], liderId: 'no-uuid' }), null)
  assert.equal(aplicaciones.length, 0, 'sin expresion resoluble no se consulta')

  assert.equal(aplicarAlcanceLider(query, { userIds: [integrante], liderId: lider }), query)
  assert.deepEqual(aplicaciones, [expresionAlcanceLider([integrante], lider)])
})

test('validacion: activador inhabilitado conserva su historial para el lider autorizado', () => {
  assert.deepEqual(idsAutorizados([integrante], lider), ['f1', 'f2', 'f5'])
  assert.deepEqual(idsAutorizados([], lider), ['f1', 'f2'], 'el historico propio no depende del equipo')

  const handler = manejador("app.get('/portal/metrics/activations'", "app.get('/portal/activations/export-rows'")
  const excelSource = readFileSync(new URL('../server/activacionesExcel.js', import.meta.url), 'utf8')
  assert.doesNotMatch(handler, /estado/)
  assert.doesNotMatch(excelSource, /estado/, 'la exportacion tampoco filtra por estado')
})

test('validacion: activador transferido A -> B no expone a B el historico de A con snapshot valido', () => {
  assert.deepEqual(idsAutorizados([integrante], lider), ['f1', 'f2', 'f5'])
  assert.ok(!idsAutorizados([integrante], lider).includes('f3'), 'A no ve lo registrado bajo B')

  const vistaDeB = idsAutorizados([integrante], liderAjeno)
  assert.deepEqual(vistaDeB, ['f3', 'f4', 'f5'], 'B ve su snapshot, los nulos de su equipo y nada mas')
  assert.ok(!vistaDeB.includes('f1'), 'B no ve el historico de A aunque el creador este hoy en su equipo')
})

test('validacion: snapshot NULL queda limitado al equipo actual', () => {
  const conEquipo = idsAutorizados([integrante], lider)
  assert.ok(conEquipo.includes('f5'), 'fila nula del integrante actual si es visible')
  assert.ok(!conEquipo.includes('f6'), 'fila nula de quien no esta en el equipo no es visible')

  const equipoVacio = idsAutorizados([], lider)
  assert.ok(!equipoVacio.includes('f5'))
  assert.ok(!equipoVacio.includes('f6'))
})

test('validacion: equipo vacio no permite acceso global', () => {
  const equipoVacio = idsAutorizados([], lider)
  assert.deepEqual(equipoVacio, ['f1', 'f2'])
  assert.ok(equipoVacio.length < filasBase.length, 'el conjunto sigue restringido')
  assert.ok(!equipoVacio.includes('f4'), 'nunca cae en el historico de otro lider')
})

function fakeSupabase(filas) {
  const consultas = []
  const query = {
    select() {
      return query
    },
    order() {
      return query
    },
    gte() {
      return query
    },
    lte() {
      return query
    },
    or(expresion) {
      consultas.push(expresion)
      return query
    },
    async range(from, to) {
      const expresiones = consultas.filter((c) => typeof c === 'string')
      const base = expresiones.length ? evaluarExpresion(filas, expresiones.at(-1)) : filas
      return { data: base.slice(from, to + 1), error: null }
    },
  }
  return { from: () => query, consultas }
}

async function exportar(userIds, liderId) {
  const supabase = fakeSupabase(filasBase)
  const alcance = { userIds, liderId }
  const result = await generateActivacionesExcel({
    adminSupabase: supabase,
    bucket: 'activaciones',
    filters: filtrosVacios,
    alcance,
  })
  return { result, supabase, alcance }
}

test('validacion: la exportacion devuelve exactamente el conjunto autorizado del listado', async () => {
  for (const [userIds, liderId] of [
    [[integrante], lider],
    [[integrante], liderAjeno],
    [[], lider],
    [null, null],
  ]) {
    const listado = evaluarExpresion(filasBase, expresionAlcanceLider(userIds, liderId))
    const { result, supabase } = await exportar(userIds, liderId)
    assert.equal(result.rowCount, listado.length, `fila por fila igual al listado (${listado.length})`)
    if (liderId && esUuid(liderId)) {
      assert.ok(
        supabase.consultas.some((c) => typeof c === 'string' && c === expresionAlcanceLider(userIds, liderId)),
        'ambas rutas construyen la misma expresion',
      )
    } else {
      assert.ok(!supabase.consultas.some((c) => typeof c === 'string'), 'rol sin alcance no restringe')
    }
  }
})

const serverSource = readFileSync(new URL('../server/app.js', import.meta.url), 'utf8')

function manejador(desde, hasta) {
  const inicio = serverSource.indexOf(desde)
  assert.ok(inicio >= 0, `no se encontro ${desde}`)
  const fin = serverSource.indexOf(hasta, inicio + desde.length)
  assert.ok(fin > inicio, `no se encontro el fin tras ${desde}`)
  return serverSource.slice(inicio, fin)
}

const FIN_HANDLERS_PORTAL = "app.use('/admin'"
const handlersActivaciones = {
  metricas: () => manejador("app.get('/portal/metrics/activations'", "app.get('/portal/activations/export-rows'"),
  pagina: () => manejador("app.get('/portal/activations/page'", "app.get('/portal/metrics/activations'"),
  exportRows: () => manejador("app.get('/portal/activations/export-rows'", "app.get('/portal/activations/:id'"),
  detalle: () => manejador("app.get('/portal/activations/:id'", FIN_HANDLERS_PORTAL),
}

test('metricas, listado y exportacion resuelven el alcance del lider con el mismo helper y sin excluir por estado', () => {
  for (const nombre of ['metricas', 'pagina', 'exportRows', 'detalle']) {
    const tramo = handlersActivaciones[nombre]()
    assert.match(tramo, /resolverAlcanceLider\(adminSupabase, req\.portalUser\)/, `${nombre}: alcance del lider autenticado`)
    assert.doesNotMatch(tramo, /estado/, `${nombre}: el estado (activo/inhabilitado) nunca acota activaciones`)
    assert.doesNotMatch(tramo, /\.in\('usuario_id', ids\)/, `${nombre}: el equipo actual no autoriza por si solo`)
  }
  assert.match(handlersActivaciones.metricas(), /aplicarAlcanceLider\(query, alcance\)/)
})

test('el helper de alcance deriva el equipo actual y el lider autenticado, sin estado', () => {
  const alcanceSource = readFileSync(new URL('../server/alcanceLider.js', import.meta.url), 'utf8')
  const funcion = alcanceSource.slice(alcanceSource.indexOf('export async function resolverAlcanceLider'))
  assert.match(funcion, /\.from\('activadores'\)\.select\('usuario_id'\)\.eq\('lider_id', portalUser\.usuario_id\)/)
  assert.match(funcion, /liderId: portalUser\.usuario_id/)
  assert.doesNotMatch(funcion, /estado/)
})

test('el detalle de una activacion enriquece la fila con el correo del activador', () => {
  const funcion = serverSource.slice(
    serverSource.indexOf('async function attachActivationCreatorEmail'),
    serverSource.indexOf('function buildEvidenceLinkPath'),
  )
  assert.match(funcion, /from\('activadores'\)\.select\('usuario_id,email'\)/)
  assert.match(funcion, /usuario_email/)
  assert.doesNotMatch(funcion, /\.eq\('estado'/, 'los correos no dependen del estado del perfil')

  assert.match(handlersActivaciones.detalle(), /attachActivationCreatorEmail\(adminSupabase/)
  assert.doesNotMatch(
    handlersActivaciones.metricas(),
    /attachActivationCreatorEmail|attachActivationSignedPhotos/,
    'las metricas no buscan correos ni firman fotos',
  )
})

const tableSource = readFileSync(new URL('../src/components/ActivacionesTable.vue', import.meta.url), 'utf8')

test('el detalle muestra Correo del activador en lugar de ID del usuario', () => {
  const secciones = tableSource.slice(
    tableSource.indexOf('const seccionesDetalleConfig = ['),
    tableSource.indexOf('\n]', tableSource.indexOf('const seccionesDetalleConfig = [')) + 2,
  )
  const tecnica = secciones.match(/Informacion tecnica del registro', keys: \[([^\]]*)\]/)?.[1] ?? ''
  assert.match(tecnica, /usuario_email/)
  assert.doesNotMatch(tecnica, /usuario_id/, 'el identificador crudo sale del bloque tecnico')
  assert.match(tableSource, /usuario_email: 'Correo del activador'/)
  assert.match(
    tableSource,
    /tieneValor\(row\.usuario_email\) \? new Set\(\['usuario_id'\]\)/,
    'si no hay correo, el ID del usuario queda como unico identificador visible',
  )
})

const metricsSource = readFileSync(new URL('../src/components/MetricsDashboard.vue', import.meta.url), 'utf8')

test('las metricas reproducen la misma regla de alcance por lider', () => {
  const inicio = metricsSource.indexOf('function liderKey(item)')
  const fin = metricsSource.indexOf('function liderEtiqueta', inicio)
  const cuerpo = metricsSource.slice(inicio, fin)
  assert.match(cuerpo, /item\.lider_id_registro/)
  assert.ok(
    cuerpo.indexOf('lider_id_registro') < cuerpo.indexOf('usuario?.lider_id'),
    'el snapshot del registro tiene prioridad sobre el líder actual del creador',
  )
  assert.match(cuerpo, /return 'none'/, 'sin regla resoluble no se atribuye')

  assert.match(
    metricsSource,
    /if \(registroId && registroId === resolvedKey\.slice\(4\) && nombreRegistro\)/,
    'el nombre de registro solo se usa cuando coincide con el snapshot; el resto es pertenencia actual',
  )

  const catalogoInicio = metricsSource.indexOf('const catalogoActivadores = computed(')
  const catalogoFin = metricsSource.indexOf('function estadoNormalizado', catalogoInicio)
  assert.doesNotMatch(
    metricsSource.slice(catalogoInicio, catalogoFin),
    /\.estado/,
    'el catalogo de activadores ignora el estado del perfil',
  )
})
