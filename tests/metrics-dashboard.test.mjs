import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { computed, ref, watch } from 'vue'
import { parse } from '@vue/compiler-sfc'
import { ciudadActivacion, etiquetaCiudadActivacion, nombreLegiblePlaza, normalizarPlazaClave, SIN_CIUDAD_REGISTRADA } from '../src/lib/plazas.js'
import { neutralizeSpreadsheetFormula } from '../src/lib/exportSafety.js'

// Ejecuta el setup real y sus computed; solo sustituye I/O y el montaje del DOM.
const source = readFileSync(new URL('../src/components/MetricsDashboard.vue', import.meta.url), 'utf8')
const setup = parse(source).descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
const actual = '10000000-0000-0000-0000-000000000001'
const anterior = '10000000-0000-0000-0000-000000000002'
const activador = '20000000-0000-0000-0000-000000000001'
const otro = '20000000-0000-0000-0000-000000000002'
const users = [{ usuario_id: activador, nombre: 'Persona de prueba', lider_id: actual, lider_nombre: 'Líder actual', rol: 'activador' }]
const rows = Array.from({ length: 5 }, (_, i) => ({
  id: `30000000-0000-0000-0000-00000000000${i + 1}`,
  usuario_id: activador, impulsador: 'Persona de prueba',
  lider_id_registro: i < 4 ? anterior : actual,
  lider_nombre_registro: i < 4 ? 'Líder anterior' : 'Líder actual',
  fecha_activacion: `2026-10-0${i + 1}`, ciudad_activacion: 'la_paz', plaza: 'La Paz', tipo_activacion: 'comercio',
}))

async function mount(authorizedRows = rows, catalog = users, catalogError = false) {
  let mounted, blob
  const deps = {
    computed, ref, watch, onMounted: (fn) => { mounted = fn },
    fetchMetricasActivaciones: async () => structuredClone(authorizedRows),
    portalRequest: async (path) => {
      assert.equal(path, '/portal/users')
      if (catalogError) throw new Error('Catálogo no disponible')
      return { users: structuredClone(catalog) }
    },
    nombreLegiblePlaza, normalizarPlazaClave, ciudadActivacion, etiquetaCiudadActivacion, SIN_CIUDAD_REGISTRADA,
    neutralizeSpreadsheetFormula,
    logClientError: () => {}, Blob,
    URL: { createObjectURL: (value) => { blob = value; return 'blob:test' }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() {} }) },
  }
  const vm = new Function(...Object.keys(deps), `${setup}\nreturn { dashboard, opciones, tarjetas, filtroLider, filtroActivador, filtroDesde, filtroHasta, filtroPlaza, filtroTipo, filtroEquipo, rankingPaginado, rankingTotalPages, rankingSiguiente, porcentajeDelTotal, exportarDashboard, errorMsg };`)(...Object.values(deps))
  await mounted()
  return { ...vm, csv: async () => { blob = null; vm.exportarDashboard(); return blob ? await blob.text() : '' } }
}

async function assertCount(vm, expected) {
  assert.equal(vm.dashboard.value.kpis.total, expected)
  assert.equal(vm.dashboard.value.rows.length, expected)
  assert.equal(vm.dashboard.value.topActivadores.reduce((n, item) => n + item.value, 0), expected)
  const csv = await vm.csv()
  assert.equal(csv ? csv.trim().split('\n').length - 1 : 0, expected)
}

test('el alcance del líder sigue lider_id_registro y conserva el corte por activador', async () => {
  const vm = await mount()
  vm.filtroActivador.value = `uid:${activador}`
  await assertCount(vm, 5)
  assert.deepEqual(vm.dashboard.value.rows.map((r) => r.id), rows.map((r) => r.id))
  assert.deepEqual(vm.dashboard.value.topLideres.map((l) => [l.key, l.value]), [[`lid:${anterior}`, 4], [`lid:${actual}`, 1]])
  assert.deepEqual(vm.opciones.value.lideres.map((l) => l.key), [`lid:${actual}`, `lid:${anterior}`])
  assert.deepEqual(vm.dashboard.value.rows, rows) // snapshots intactos
  vm.filtroLider.value = `lid:${actual}`
  await assertCount(vm, 1) // solo la activación registrada bajo el líder actual
  vm.filtroLider.value = `lid:${anterior}`
  await assertCount(vm, 4) // las registradas bajo el líder anterior
})

test('mantiene filtros de fechas, plaza, tipo y activador sobre el mismo corte', async () => {
  const vm = await mount()
  vm.filtroLider.value = `lid:${anterior}`
  vm.filtroActivador.value = `uid:${activador}`
  vm.filtroDesde.value = '2026-10-02'
  vm.filtroHasta.value = '2026-10-04'
  vm.filtroPlaza.value = 'pkey:lapaz'
  vm.filtroTipo.value = 'comercio'
  await assertCount(vm, 3)
  for (const [filter, value] of [[vm.filtroPlaza, 'pkey:oruro'], [vm.filtroTipo, 'otro'], [vm.filtroActivador, `uid:${otro}`]]) {
    const original = filter.value
    filter.value = value
    await assertCount(vm, 0)
    filter.value = original
  }
})

test('no agrega registros desde el catálogo; conserva alcance global y UUID con nombres iguales', async () => {
  const catalog = [...users, { usuario_id: otro, nombre: 'Persona de prueba', lider_id: anterior, lider_nombre: 'Otra líder', rol: 'activador' }]
  const leader = await mount(rows, catalog)
  await assertCount(leader, 5) // el catálogo nunca agrega activaciones
  const admin = await mount([...rows, { ...rows[0], id: '40000000-0000-0000-0000-000000000001', usuario_id: otro }], catalog)
  await assertCount(admin, 6)
  assert.equal(admin.dashboard.value.topActivadores.length, 2)
  assert.equal(new Set(admin.dashboard.value.topActivadores.map((r) => r.key)).size, 2)
  admin.filtroLider.value = `lid:${actual}`
  await assertCount(admin, 1) // solo la fila registrada bajo el líder actual
  admin.filtroLider.value = `lid:${anterior}`
  await assertCount(admin, 5) // 4 del activador + 1 del otro, ambas bajo el anterior
  admin.filtroLider.value = ''
  await assertCount(admin, 6)
})

test('ranking general incluye todo el catálogo sin excluir inhabilitados, deduplicados y con cero', async () => {
  const cero = '20000000-0000-0000-0000-000000000003'
  const multirrol = '20000000-0000-0000-0000-000000000004'
  const catalog = [
    { ...users[0], nombre: 'Zulma', estado: 'activo' },
    { ...users[0], usuario_id: cero, nombre: 'Ana', estado: 'activo' },
    { ...users[0], usuario_id: cero, nombre: 'Ana', estado: 'activo' },
    { ...users[0], usuario_id: multirrol, nombre: 'Berta', estado: 'activo', rol: 'lider', roles: ['lider', 'activador'] },
    { ...users[0], usuario_id: otro, nombre: 'Inactivo', estado: 'inactivo' },
    { ...users[0], usuario_id: 'solo-lider', nombre: 'Líder', estado: 'activo', rol: 'lider' },
    { ...users[0], usuario_id: 'solo-admin', nombre: 'Admin', estado: 'activo', rol: 'administrador' },
  ]
  const vm = await mount(rows, catalog)
  assert.deepEqual(vm.dashboard.value.topActivadores.map((item) => [item.key, item.value]), [
    [`uid:${activador}`, 5], [`uid:${cero}`, 0], [`uid:${multirrol}`, 0], [`uid:${otro}`, 0],
  ])
  assert.equal(vm.opciones.value.activadores.filter((item) => item.key === `uid:${cero}`).length, 1)
  vm.filtroActivador.value = `uid:${cero}`
  await assertCount(vm, 0)
  assert.deepEqual(vm.dashboard.value.topActivadores.map((item) => [item.label, item.value]), [['Ana', 0]])
  vm.filtroActivador.value = ''
  vm.filtroDesde.value = '2027-01-01'
  vm.filtroPlaza.value = 'pkey:oruro'
  vm.filtroTipo.value = 'otro'
  await assertCount(vm, 0)
  assert.deepEqual(vm.dashboard.value.topActivadores.map((item) => item.label), ['Ana', 'Berta', 'Inactivo (inhabilitado)', 'Zulma'])
})

test('un fallo del catálogo no publica métricas de líder incompletas', async () => {
  const vm = await mount(rows, users, true)
  assert.ok(vm.errorMsg.value)
  await assertCount(vm, 0)
})

test('equipo combina integrantes autorizados con 0, 1 y varias activaciones sin cambiar totales', async () => {
  const equipo = '50000000-0000-0000-0000-000000000001'
  const otroEquipo = '50000000-0000-0000-0000-000000000002'
  const cero = '20000000-0000-0000-0000-000000000003'
  const catalog = [
    { ...users[0], equipo_id: equipo, nombre: 'Zulma' },
    { ...users[0], usuario_id: otro, equipo_id: equipo, nombre: 'Berta' },
    { ...users[0], usuario_id: cero, equipo_id: equipo, nombre: 'Ana' },
    { ...users[0], usuario_id: 'fuera', equipo_id: otroEquipo, nombre: 'Fuera' },
    { ...users[0], usuario_id: 'no-activador', equipo_id: equipo, rol: 'lider' },
  ]
  const records = [
    ...rows.slice(0, 3).map((r) => ({ ...r, equipo_id_registro: equipo })),
    { ...rows[3], usuario_id: otro, equipo_id_registro: equipo },
  ]
  const vm = await mount(records, catalog)
  const baselineKpis = { ...vm.dashboard.value.kpis }
  const baselineRanking = structuredClone(vm.dashboard.value.topActivadores)
  const baselineCsv = await vm.csv()
  vm.filtroEquipo.value = `id:${equipo}`
  assert.deepEqual(vm.dashboard.value.topActivadores.map((r) => [r.key, r.value]), [
    [`uid:${activador}`, 3], [`uid:${otro}`, 1], [`uid:${cero}`, 0],
  ])
  assert.equal(parseFloat(vm.porcentajeDelTotal(0)), 0)
  assert.deepEqual(vm.dashboard.value.kpis, baselineKpis)
  assert.equal(await vm.csv(), baselineCsv)
  assert.ok(vm.opciones.value.activadores.some((a) => a.key === `uid:${cero}`))
  vm.filtroActivador.value = `uid:${cero}`
  await assertCount(vm, 0)
  assert.equal(vm.dashboard.value.topActivadores.length, 1)
  vm.filtroActivador.value = 'uid:fuera'
  assert.equal(vm.dashboard.value.topActivadores.length, 0)
  vm.filtroActivador.value = ''
  vm.filtroDesde.value = '2027-01-01'
  await assertCount(vm, 0)
  assert.deepEqual(vm.dashboard.value.topActivadores.map((r) => r.label), ['Ana', 'Berta', 'Zulma'])
  assert.equal(vm.porcentajeDelTotal(0), '0%')
  vm.filtroDesde.value = ''
  vm.filtroLider.value = `lid:${anterior}`
  // Sin integrantes actuales del líder anterior, el ranking muestra a los
  // activadores cuyas filas sí quedan atribuidas a él (suma == total).
  assert.deepEqual(vm.dashboard.value.topActivadores.map((r) => [r.key, r.value]), [
    [`uid:${activador}`, 3], [`uid:${otro}`, 1],
  ])
  vm.filtroLider.value = ''
  vm.filtroEquipo.value = ''
  assert.deepEqual(vm.dashboard.value.topActivadores, baselineRanking)
  assert.deepEqual(vm.dashboard.value.kpis, baselineKpis)
  const restricted = await mount(records, catalog.slice(0, 3))
  restricted.filtroEquipo.value = `id:${otroEquipo}`
  assert.equal(restricted.dashboard.value.topActivadores.length, 0)
  assert.ok(!restricted.opciones.value.equipos.some((e) => e.key === `id:${otroEquipo}`))

  // Equipo sin ninguna activación, homónimos y paginación conservada.
  const emptyTeam = await mount([], Array.from({ length: 11 }, (_, i) => ({
    ...catalog[0], usuario_id: `60000000-0000-0000-0000-${String(i).padStart(12, '0')}`, nombre: 'Homónimo',
  })))
  assert.ok(emptyTeam.opciones.value.equipos.some((e) => e.key === `id:${equipo}`))
  assert.equal(emptyTeam.dashboard.value.topActivadores.length, 11)
  emptyTeam.filtroEquipo.value = `id:${equipo}`
  await assertCount(emptyTeam, 0)
  assert.equal(emptyTeam.dashboard.value.topActivadores.length, 11)
  assert.equal(emptyTeam.rankingTotalPages.value, 2)
  assert.equal(emptyTeam.rankingPaginado.value.length, 10)
  emptyTeam.rankingSiguiente()
  assert.equal(emptyTeam.rankingPaginado.value.length, 1)
})

test('reconoce Cliente antiguo como categoría sin alterar los tipos existentes', async () => {
  const clienteAntiguo = {
    ...rows[3], id: '90000000-0000-0000-0000-000000000001',
    tipo_activacion: 'cliente_antiguo', base_activacion: 'cliente_antiguo',
  }
  const data = [
    ...rows.slice(0, 3),
    clienteAntiguo,
    { ...rows[4], id: '90000000-0000-0000-0000-000000000002', tipo_activacion: 'transeunte' },
  ]
  const vm = await mount(data)
  await assertCount(vm, 5)

  const clasificacion = Object.fromEntries(vm.dashboard.value.porClasificacion.map((i) => [i.label, i.value]))
  assert.equal(clasificacion['Cliente antiguo'], 1)
  assert.equal(clasificacion.Comercio, 3)
  assert.equal(vm.dashboard.value.kpis.tiendas, 0)

  const tipos = Object.fromEntries(vm.dashboard.value.porTipo.map((i) => [i.label, i.value]))
  assert.deepEqual(tipos, { comercio: 3, 'Cliente antiguo': 1, transeunte: 1 })
  assert.ok(vm.opciones.value.tipos.some((t) => t.key === 'cliente_antiguo' && t.nombre === 'Cliente antiguo'))

  vm.filtroTipo.value = 'cliente_antiguo'
  await assertCount(vm, 1)
  vm.filtroTipo.value = 'no-existe'
  await assertCount(vm, 0)
  vm.filtroTipo.value = ''
  await assertCount(vm, 5)
})

test('la ciudad geográfica prevalece sobre la plaza organizacional en selector, filtro y gráfico Ciudades', async () => {
  const pidAlto = '70000000-0000-0000-0000-000000000001'
  const pidOruro = '70000000-0000-0000-0000-000000000002'
  const data = [
    // Activador de La Paz que activó en El Alto.
    { ...rows[0], id: 'a0000000-0000-0000-0000-000000000001', ciudad_activacion: 'el_alto', plaza_efectiva_id_registro: pidAlto, plaza_efectiva_registro: 'La Paz', plaza_base_registro: 'La Paz' },
    { ...rows[1], id: 'a0000000-0000-0000-0000-000000000002', ciudad_activacion: 'El Alto', plaza_efectiva_id_registro: pidAlto, plaza_efectiva_registro: 'el_alto', plaza: '' },
    // Activador de El Alto que activó en La Paz.
    { ...rows[2], id: 'a0000000-0000-0000-0000-000000000003', ciudad_activacion: 'la_paz', plaza_efectiva_id_registro: pidOruro, plaza_efectiva_registro: 'El Alto' },
    // Sin ciudad registrada: no se sustituye por la plaza del activador.
    { ...rows[3], id: 'a0000000-0000-0000-0000-000000000004', ciudad_activacion: null, plaza_efectiva_id_registro: pidAlto, plaza_efectiva_registro: 'La Paz', plaza: 'La Paz' },
    { ...rows[4], id: 'a0000000-0000-0000-0000-000000000005', ciudad_activacion: '   ', plaza_efectiva_id_registro: pidOruro, plaza_efectiva_registro: 'Oruro', plaza: '' },
  ]
  const vm = await mount(data)
  await assertCount(vm, 5)

  const alto = vm.opciones.value.plazas.filter((p) => normalizarPlazaClave(p.nombre) === 'elalto')
  assert.equal(alto.length, 1, "'el_alto' y 'El Alto' son la misma ciudad")
  assert.equal(alto[0].key, 'pkey:elalto')
  assert.equal(alto[0].nombre, 'El Alto')

  const lapaz = vm.opciones.value.plazas.filter((p) => normalizarPlazaClave(p.nombre) === 'lapaz')
  assert.equal(lapaz.length, 1, 'la plaza organizacional El Alto no crea otra ciudad de La Paz')
  assert.equal(lapaz[0].key, 'pkey:lapaz')

  const sinCiudad = vm.opciones.value.plazas.find((p) => p.key === 'none')
  assert.equal(sinCiudad.nombre, SIN_CIUDAD_REGISTRADA)

  const barras = Object.fromEntries(vm.dashboard.value.porPlaza.map((i) => [i.key, i.value]))
  assert.equal(barras['pkey:elalto'], 2, 'las dos filas con ciudad El Alto se agrupan juntas')
  assert.equal(barras['pkey:lapaz'], 1, 'la fila con plaza organizacional El Alto cuenta como La Paz')
  assert.equal(barras.none, 2, 'ciudad NULL o vacía agrupa en "Sin ciudad registrada"')

  vm.filtroPlaza.value = 'pkey:elalto'
  await assertCount(vm, 2)
  assert.ok((await vm.csv()).includes('El Alto'))
  vm.filtroPlaza.value = 'none'
  await assertCount(vm, 2)
  assert.ok((await vm.csv()).includes(SIN_CIUDAD_REGISTRADA))
  vm.filtroPlaza.value = ''
  await assertCount(vm, 5)
})

test('KPI Comercios cuenta solo registros con tipo_activacion comercio exacto', async () => {
  const data = [
    { ...rows[0], id: 'b0000000-0000-0000-0000-000000000001', tipo_activacion: 'comercio', nombre_comercio: 'Kiosko Sur' },
    { ...rows[1], id: 'b0000000-0000-0000-0000-000000000002', tipo_activacion: 'comercio' },
    { ...rows[2], id: 'b0000000-0000-0000-0000-000000000003', tipo_activacion: 'reactivacion_comercio', nombre_comercio: 'Minimarket Norte' },
    { ...rows[3], id: 'b0000000-0000-0000-0000-000000000004', tipo_activacion: 'transeunte', nombre_comercio: 'Puesto Central' },
    { ...rows[4], id: 'b0000000-0000-0000-0000-000000000005', tipo_activacion: 'Comercio', nombre_comercio: 'Tienda Mix' },
  ]
  const vm = await mount(data)
  assert.equal(vm.dashboard.value.kpis.comercios, 3)

  const kpiComercios = vm.tarjetas.value.find((card) => card.key === 'comercios')
  assert.equal(kpiComercios.value, '3')
  assert.equal(kpiComercios.note, 'Registros con tipo comercio')

  vm.filtroTipo.value = 'comercio'
  await assertCount(vm, 3)
  assert.equal(vm.dashboard.value.kpis.comercios, 3)
  vm.filtroTipo.value = 'reactivacion_comercio'
  await assertCount(vm, 1)
  assert.equal(vm.dashboard.value.kpis.comercios, 0)
})

test('promedios diario y semanal usan días calendario del intervalo seleccionado', async () => {
  const vm = await mount()
  vm.filtroDesde.value = '2026-10-02'
  vm.filtroHasta.value = '2026-10-04'
  await assertCount(vm, 3)
  const { calendarioDiario, calendarioSemanal, diasPeriodo } = vm.dashboard.value.promedios
  assert.equal(diasPeriodo, 3) // 02, 03 y 04 inclusive
  assert.equal(calendarioDiario, 1) // 3 activaciones / 3 días
  assert.equal(calendarioSemanal, 7) // 3 / (3/7)
  const diaria = vm.tarjetas.value.find((card) => card.key === 'promedio-diario')
  const semanal = vm.tarjetas.value.find((card) => card.key === 'promedio-semanal')
  assert.equal(diaria.value, '1,0')
  assert.equal(semanal.value, '7,0')
  assert.equal(diaria.note, '3 días calendario')
})

test('promedios incluyen días sin activaciones en el denominador', async () => {
  const data = [
    { ...rows[0], id: 'c0000000-0000-0000-0000-000000000001', fecha_activacion: '2026-10-01' },
    { ...rows[1], id: 'c0000000-0000-0000-0000-000000000002', fecha_activacion: '2026-10-05' },
  ]
  const vm = await mount(data)
  vm.filtroDesde.value = '2026-10-01'
  vm.filtroHasta.value = '2026-10-05'
  await assertCount(vm, 2)
  const { calendarioDiario, calendarioSemanal, diasPeriodo } = vm.dashboard.value.promedios
  assert.equal(diasPeriodo, 5) // incluye el 02, 03 y 04 sin activaciones
  assert.equal(calendarioDiario, 0.4) // 2 / 5
  assert.equal(calendarioSemanal, 2.8) // 2 / (5/7)
  assert.equal(vm.tarjetas.value.find((card) => card.key === 'promedio-diario').value, '0,4')
  assert.equal(vm.tarjetas.value.find((card) => card.key === 'promedio-semanal').value, '2,8')
})

test('promedios recalculan con filtros no de fecha sobre el mismo período', async () => {
  const vm = await mount()
  vm.filtroDesde.value = '2026-10-01'
  vm.filtroHasta.value = '2026-10-05'
  await assertCount(vm, 5)
  assert.equal(vm.dashboard.value.promedios.calendarioDiario, 1) // 5 / 5
  vm.filtroPlaza.value = 'pkey:oruro'
  await assertCount(vm, 0)
  assert.equal(vm.dashboard.value.promedios.calendarioDiario, 0) // protegido: 0 / 5
  assert.equal(vm.dashboard.value.promedios.calendarioSemanal, 0)
  vm.filtroPlaza.value = 'pkey:lapaz'
  await assertCount(vm, 5)
  assert.equal(vm.dashboard.value.promedios.calendarioDiario, 1)
  vm.filtroTipo.value = 'no-existe'
  await assertCount(vm, 0)
  assert.equal(vm.dashboard.value.promedios.calendarioSemanal, 0)
})

test('promedios protegen período vacío, futuro y dataset vacío', async () => {
  const vm = await mount()
  // Desde futuro: ninguna fila y ventana invertida -> 0 días -> 0 sin NaN.
  vm.filtroDesde.value = '2099-01-01'
  await assertCount(vm, 0)
  assert.equal(vm.dashboard.value.promedios.diasPeriodo, 0)
  assert.equal(vm.dashboard.value.promedios.calendarioDiario, 0)
  assert.equal(vm.dashboard.value.promedios.calendarioSemanal, 0)
  assert.equal(vm.tarjetas.value.find((card) => card.key === 'promedio-diario').value, '0,0')
  // Hasta futuro se recorta a hoy; sin fechas el período es el mes actual hasta hoy.
  vm.filtroDesde.value = ''
  vm.filtroHasta.value = '2099-12-31'
  const conHastaFuturo = vm.dashboard.value.promedios
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const hoy = `${parts.year}-${parts.month}-${parts.day}`
  assert.equal(conHastaFuturo.periodoHasta, hoy)
  assert.ok(conHastaFuturo.diasPeriodo > 0)
  // Dataset vacío con período válido -> 0.
  const vacio = await mount([])
  assert.equal(vacio.dashboard.value.promedios.calendarioDiario, 0)
  assert.equal(vacio.dashboard.value.promedios.calendarioSemanal, 0)
})

test('sin fechas seleccionadas los promedios usan el mes actual hasta hoy', async () => {
  const vm = await mount()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const hoy = `${parts.year}-${parts.month}-${parts.day}`
  const mesInicio = `${parts.year}-${parts.month}-01`
  const { calendarioDiario, calendarioSemanal, diasPeriodo, periodoDesde, periodoHasta, total } = { ...vm.dashboard.value.promedios, total: vm.dashboard.value.kpis.total }
  assert.equal(periodoDesde, mesInicio)
  assert.equal(periodoHasta, hoy)
  const diasEsperados = Math.round((Date.parse(`${hoy}T12:00:00Z`) - Date.parse(`${mesInicio}T12:00:00Z`)) / 86400000) + 1
  assert.equal(diasPeriodo, diasEsperados)
  assert.equal(calendarioDiario, total / diasEsperados)
  assert.equal(calendarioSemanal, total / (diasEsperados / 7))
})

test('la tarjeta Cash-In se oculta pero conserva cash_in en datos y CSV', async () => {
  const data = rows.map((row, index) => ({ ...row, cash_in: index < 2 }))
  const vm = await mount(data)
  assert.ok(!vm.tarjetas.value.some((card) => card.key === 'cash-in'))
  assert.equal(vm.dashboard.value.kpis.cashIn, 2)
  const csv = await vm.csv()
  const [header, ...lineas] = csv.trim().split('\n')
  assert.ok(header.includes('Cash-In'))
  assert.equal(lineas.filter((linea) => linea.includes(',"Si",')).length, 2)
})
