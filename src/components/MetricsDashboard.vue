<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { fetchMetricasActivaciones, portalRequest } from '../lib/activacionesService'
import MetricsHeatMap from './MetricsHeatMap.vue'
import { ciudadActivacion, etiquetaCiudadActivacion, normalizarPlazaClave, SIN_CIUDAD_REGISTRADA } from '../lib/plazas'
import { neutralizeSpreadsheetFormula } from '../lib/exportSafety'
import { logClientError } from '../lib/logging'

const activaciones = ref([])
const loading = ref(true)
const errorMsg = ref(null)
const filtroDesde = ref('')
const filtroHasta = ref('')
const filtroPlaza = ref('')
const filtroActivador = ref('')
const filtroTipo = ref('')
const filtroLider = ref('')
const filtroEquipo = ref('')
const rankingPage = ref(1)
const rankingPageSize = 10
watch([filtroDesde, filtroHasta, filtroPlaza, filtroActivador, filtroTipo, filtroLider, filtroEquipo], () => { rankingPage.value = 1 })
// Catálogo de líderes desde /portal/users (mismo alcance autorizado del endpoint:
// admin lo recibe completo; líder/banco lo reciben recortado por el backend).
// Relaciona usuario_id con su líder actual sin ampliar las activaciones autorizadas.
const usuariosCatalogo = ref([])
const plazasCatalogo = ref([])
const usuariosPorId = computed(() => new Map(usuariosCatalogo.value.map((usuario) => [texto(usuario.usuario_id).toLowerCase(), usuario])))
function rolesCatalogo(usuario) {
  if (Array.isArray(usuario?.roles)) return usuario.roles.map((rol) => String(rol ?? '').trim().toLowerCase())
  return [String(usuario?.rol ?? '').trim().toLowerCase()]
}
// Catálogo de activadores sin filtro de estado: un perfil inhabilitado conserva
// sus activaciones históricas en ranking, métricas y selectores.
const catalogoActivadores = computed(() => [...usuariosPorId.value.values()].filter((usuario) => {
  const id = texto(usuario.usuario_id)
  return Boolean(id) && rolesCatalogo(usuario).includes('activador')
}))
function estadoNormalizado(usuario) { return normalizado(usuario?.estado || 'activo') }
function etiquetaConEstado(usuario, etiqueta) {
  if (estadoNormalizado(usuario) === 'activo') return etiqueta
  return /\(inhabilitado\)$/i.test(etiqueta) ? etiqueta : `${etiqueta} (inhabilitado)`
}
const catalogoLideres = computed(() => {
  const lideres = new Map()
  for (const usuario of usuariosCatalogo.value) {
    if (!rolesCatalogo(usuario).includes('lider')) continue
    const id = texto(usuario.usuario_id).toLowerCase()
    if (!id || lideres.has(id)) continue
    lideres.set(id, { nombre: texto(usuario.nombre), estado: texto(usuario.estado) || 'activo' })
  }
  return lideres
})
const numberFormatter = new Intl.NumberFormat('es-BO')
const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
const todayKey = `${todayParts.year}-${todayParts.month}-${todayParts.day}`
const monthKey = `${todayParts.year}-${todayParts.month}`
const todayDate = new Date(`${todayKey}T12:00:00Z`)
const weekStartDate = new Date(todayDate)
weekStartDate.setUTCDate(todayDate.getUTCDate() - ((todayDate.getUTCDay() + 6) % 7))
const weekStartKey = weekStartDate.toISOString().slice(0, 10)

onMounted(async () => {
  loading.value = true
  errorMsg.value = null
  try {
    const [rows, usersPayload, plazasPayload] = await Promise.all([
      fetchMetricasActivaciones(),
      portalRequest('/portal/users'),
      portalRequest('/portal/plazas').catch((error) => { logClientError('metricas.plazas', error); return null }),
    ])
    activaciones.value = rows
    usuariosCatalogo.value = usersPayload?.users ?? []
    plazasCatalogo.value = plazasPayload?.plazas ?? []
  }
  catch (error) { logClientError('metricas.fetch', error); errorMsg.value = 'No fue posible obtener las activaciones.' }
  finally { loading.value = false }
})

function texto(value) { return typeof value === 'string' ? value.trim() : '' }
function normalizado(value) { return texto(value).toLocaleLowerCase('es') }
function fechaRegistro(item) { return (texto(item.fecha_activacion) || texto(item.created_at)).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '' }
function plazaRegistro(item) { return etiquetaCiudadActivacion(item) }
// Identidad de ciudad de activación: única fuente `ciudad_activacion`,
// normalizada con normalizarPlazaClave -> pkey:<clave>. Sin ciudad registrada
// -> 'none' (etiqueta "Sin ciudad registrada"). La plaza organizacional
// (plaza_efectiva_registro / plaza_base_registro) no participa: es
// atribución de equipo, no ubicación geográfica.
function plazaTextoBruto(item) { return ciudadActivacion(item) }
function plazaKey(item) {
  const nombre = plazaTextoBruto(item)
  if (nombre) return `pkey:${normalizarPlazaClave(nombre)}`
  return 'none'
}
function plazaEtiqueta(item) {
  const nombre = plazaTextoBruto(item)
  if (nombre) return nombre
  return SIN_CIUDAD_REGISTRADA
}
// Regla de atribución de líder, en orden:
// 1) lider_id_registro (snapshot del momento del registro) cuando existe.
// 2) Si el snapshot es NULL: líder actual del creador (activadores.lider_id),
//    resoluble solo contra el catálogo autorizado.
// 3) Sin regla resoluble: 'none' (sin atribución; nunca por nombre ni plaza).
function liderKey(item) {
  const registro = texto(item.lider_id_registro).toLowerCase()
  if (registro) return `lid:${registro}`
  const usuario = usuariosPorId.value.get(texto(item.usuario_id).toLowerCase())
  const id = texto(usuario?.lider_id).toLowerCase()
  if (id) return `lid:${id}`
  return 'none'
}
function liderEtiqueta(item, key) {
  const resolvedKey = key ?? liderKey(item)
  if (resolvedKey.startsWith('lid:')) {
    const registroId = texto(item?.lider_id_registro).toLowerCase()
    const nombreRegistro = texto(item?.lider_nombre_registro)
    if (registroId && registroId === resolvedKey.slice(4) && nombreRegistro) return nombreRegistro
    const catalogado = liderCatalogo.value.get(resolvedKey.slice(4)) ?? ''
    if (catalogado) return catalogado
    const delCatalogo = catalogoLideres.value.get(resolvedKey.slice(4))?.nombre ?? ''
    if (delCatalogo) return delCatalogo
    return `Líder · ${resolvedKey.slice(4, 12)}`
  }
  return ''
}
const liderCatalogo = computed(() => {
  const nombres = new Map()
  for (const usuario of usuariosCatalogo.value) {
    const id = texto(usuario.lider_id).toLowerCase()
    if (!id || nombres.has(id)) continue
    const nombre = texto(usuario.lider_nombre)
    if (nombre) nombres.set(id, nombre)
  }
  return nombres
})
// Identidad canonica de activador (snapshot historico):
// 1) usuario_id (uuid not null: quien registro la activacion)
// Sin UUID no se atribuye una persona por su nombre visible.
function activadorKey(item) {
  const id = texto(item.usuario_id).toLowerCase()
  if (id) return `uid:${id}`
  return 'none'
}
function activadorEtiqueta(item, key) {
  const nombre = texto(item.impulsador)
  if (nombre) return nombre
  const resolvedKey = key ?? activadorKey(item)
  if (resolvedKey.startsWith('uid:')) {
    const catalogado = activadorCatalogo.value.get(resolvedKey.slice(4)) ?? ''
    if (catalogado) return catalogado
    return `Activador · ${resolvedKey.slice(4, 12)}`
  }
  return 'Sin activador'
}
const activadorCatalogo = computed(() => {
  const nombres = new Map()
  for (const item of activaciones.value) {
    const id = texto(item.usuario_id).toLowerCase()
    if (!id || nombres.has(id)) continue
    const nombre = texto(item.impulsador)
    if (nombre) nombres.set(id, nombre)
  }
  return nombres
})
// Key normalizada de tipo: solo diferencias no semanticas (espacios/case).
// La etiqueta conserva el texto original (primer visto).
function tipoKey(item) { return normalizado(texto(item.tipo_activacion)) || 'none' }
// Catálogo funcional de tipos con valor técnico CONFIRMADO en código
// (reimpresion_qr por validar_elegibilidad_reactivacion; cliente_antiguo por
// tipo_activacion/base_activacion='cliente_antiguo'). Los demás tipos del
// catálogo funcional (Comercio, Reactivación*, Transeúnte, Limbo, No habilitado,
// Configuración de cuenta) no tienen valor técnico exacto confirmable en el
// código disponible (solo prefijos/subcadenas o ninguna mención) y NO se inventan:
// aparecen como históricos cuando existen en los datos. La categoría
// (Comercio/Tienda/Transeúnte) no es un campo almacenado: se deriva del texto
// combinado (clasificacionRegistro / es*Row), por eso el catálogo es plano.
const TIPOS_FUNCIONALES = [
  { tecnico: 'reimpresion_qr', nombre: 'Reimpresión QR' },
  { tecnico: 'cliente_antiguo', nombre: 'Cliente antiguo' },
]
function equipoIdTexto(item) { return texto(item.equipo_id_registro).toLowerCase() }
function equipoNumeroTexto(item) {
  const raw = item.equipo_numero_registro
  if (raw === null || raw === undefined) return ''
  const value = String(raw).trim()
  return value === '' ? '' : value
}
// Identidad canonica de equipo (snapshot historico, sin joins):
// 1) equipo_id_registro (UUID FK a equipos.id, lo mas estable)
// 2) equipo_numero_registro unificado al id cuando el dataset lo permite sin ambiguedad
//    (equipos.numero es unique not null; si un numero mapea a varios ids no se unifica)
// 3) equipo_numero_registro solo
// 4) equipo_nombre_registro
// 5) 'none' (sin equipo)
const equipoCatalogo = computed(() => {
  const porId = new Map()
  const idsPorNumero = new Map()
  for (const item of activaciones.value) {
    const id = equipoIdTexto(item)
    if (!id) continue
    const numero = equipoNumeroTexto(item)
    const nombre = texto(item.equipo_nombre_registro)
    let entry = porId.get(id)
    if (!entry) { entry = { numero: '', nombre: '' }; porId.set(id, entry) }
    if (!entry.numero && numero) entry.numero = numero
    if (!entry.nombre && nombre) entry.nombre = nombre
    if (numero) {
      let ids = idsPorNumero.get(numero)
      if (!ids) { ids = new Set(); idsPorNumero.set(numero, ids) }
      ids.add(id)
    }
  }
  const numeroAId = new Map()
  for (const [numero, ids] of idsPorNumero) {
    if (ids.size === 1) numeroAId.set(numero, [...ids][0])
  }
  return { porId, numeroAId }
})
function equipoKey(item) {
  const id = equipoIdTexto(item)
  if (id) return `id:${id}`
  const numero = equipoNumeroTexto(item)
  if (numero) {
    const unificado = equipoCatalogo.value.numeroAId.get(numero)
    if (unificado) return `id:${unificado}`
    return `num:${numero}`
  }
  const nombre = texto(item.equipo_nombre_registro)
  if (nombre) return `name:${nombre.toLocaleLowerCase('es')}`
  return 'none'
}
function equipoEtiqueta(item, key) {
  const resolvedKey = key ?? equipoKey(item)
  const numero = equipoNumeroTexto(item) ||
    (resolvedKey.startsWith('id:') ? (equipoCatalogo.value.porId.get(resolvedKey.slice(3))?.numero ?? '') : '') ||
    (resolvedKey.startsWith('num:') ? resolvedKey.slice(4) : '')
  if (numero) return `Equipo #${numero}`
  const nombre = texto(item.equipo_nombre_registro) ||
    (resolvedKey.startsWith('id:') ? (equipoCatalogo.value.porId.get(resolvedKey.slice(3))?.nombre ?? '') : '')
  if (nombre) return nombre
  if (resolvedKey.startsWith('id:')) return `Equipo · ${resolvedKey.slice(3, 11)}`
  return 'Sin equipo'
}
function comercioRegistro(item) { return texto(item.nombre_comercio) || texto(item.comercio) || texto(item.cliente) || texto(item.nombres_cliente) }
// Solo integrantes del catálogo autorizado; la pertenencia es actual y por UUID.
const integrantesEquipo = computed(() => {
  if (!filtroEquipo.value) return []
  return catalogoActivadores.value.filter((usuario) => {
    const equipoId = texto(usuario.equipo_id).toLowerCase()
    if (!equipoId) return false
    if (`id:${equipoId}` !== filtroEquipo.value) return false
    return !filtroLider.value || liderKey(usuario) === filtroLider.value
  })
})
const integrantesRanking = computed(() => (filtroEquipo.value ? integrantesEquipo.value : catalogoActivadores.value).filter((usuario) => {
  const key = activadorKey(usuario)
  if (filtroActivador.value && key !== filtroActivador.value) return false
  if (filtroLider.value && liderKey(usuario) !== filtroLider.value) return false
  return true
}))
function formatNumber(value) { return numberFormatter.format(Number(value) || 0) }
function formatDecimal(value) { return numberFormatter.format(Number(value.toFixed(1)) || 0) }
// Promedios con 1 decimal y separador es-BO (muestra "1,0", no "1").
function formatPromedio(value) { const n = Math.round((Number(value) || 0) * 10) / 10; return n.toFixed(1).replace('.', ',') }
function formatDate(value) { const [year, month, day] = String(value || '').split('-'); return year && month && day ? `${day}/${month}/${year}` : 'Sin fecha' }
function formatShortDate(value) { const [year, month, day] = String(value || '').split('-'); return year && month && day ? `${Number(day)}/${Number(month)}` : 'S/F' }
function formatMonth(value) { const [year, month] = String(value || '').split('-'); return year && month ? `${month}/${year}` : 'Sin mes' }
function monthRegistro(fecha) { return String(fecha || '').match(/^\d{4}-\d{2}/)?.[0] ?? 'Sin mes' }
function weekRegistro(fecha) {
  if (!fecha) return 'Sin semana'
  const date = new Date(`${fecha}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return 'Sin semana'
  const start = new Date(date)
  start.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return start.toISOString().slice(0, 10)
}
function diasEntre(desde, hasta) {
  if (!desde || !hasta || desde > hasta) return 0
  const a = Date.parse(`${desde}T12:00:00Z`)
  const b = Date.parse(`${hasta}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86400000) + 1
}
function sumar(map, key) { const label = texto(key) || 'Sin especificar'; map.set(label, (map.get(label) ?? 0) + 1) }
function ranking(map, limit = Infinity) { return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).slice(0, limit).map(([label, value]) => ({ label, value })) }
function clasificacionRegistro(item) {
  const value = `${normalizado(item.tipo_activacion)} ${normalizado(item.tipo_comercio)} ${normalizado(item.tipo_tienda)}`
  if (value.includes('cliente_antiguo') || value.includes('cliente antiguo')) return 'Cliente antiguo'
  if (value.includes('mercado')) return 'Mercado'
  if (value.includes('barrio') || value.includes('tienda')) return 'Barrio'
  if (value.includes('comercio')) return 'Comercio'
  return 'Sin clasificación'
}

const opciones = computed(() => {
  const plazas = new Map(), activadores = new Map(), tipos = new Map(), lideres = new Map()
  const equipos = new Map()
  for (const item of activaciones.value) {
    const plaza = plazaKey(item)
    if (!plazas.has(plaza)) plazas.set(plaza, { key: plaza, nombre: plazaEtiqueta(item) })
    const activador = activadorKey(item)
    if (!activadores.has(activador)) activadores.set(activador, { key: activador, nombre: activadorEtiqueta(item, activador) })
    const tipo = tipoKey(item)
    if (tipo !== 'none' && !tipos.has(tipo)) tipos.set(tipo, { key: tipo, nombre: texto(item.tipo_activacion) })
    const lider = liderKey(item)
    if (lider !== 'none' && !lideres.has(lider)) lideres.set(lider, { key: lider, nombre: liderEtiqueta(item, lider) })
    const key = equipoKey(item)
    if (!equipos.has(key)) equipos.set(key, { key, nombre: equipoEtiqueta(item, key) })
  }
  for (const plaza of plazasCatalogo.value) {
    const nombre = texto(plaza.nombre)
    const clave = normalizarPlazaClave(nombre)
    if (!clave) continue
    const key = `pkey:${clave}`
    if (!plazas.has(key)) plazas.set(key, { key, nombre })
  }
  // Hace seleccionables también los equipos e integrantes sin registros.
  for (const usuario of catalogoActivadores.value) {
    const id = texto(usuario.equipo_id).toLowerCase()
    if (!id) continue
    const key = `id:${id}`
    if (!equipos.has(key)) equipos.set(key, { key, nombre: equipoEtiqueta({ equipo_id_registro: id, equipo_numero_registro: usuario.equipo_numero, equipo_nombre_registro: usuario.equipo_nombre }, key) })
  }
  for (const usuario of catalogoActivadores.value) {
    const key = activadorKey(usuario)
    if (!activadores.has(key)) activadores.set(key, { key, nombre: etiquetaConEstado(usuario, texto(usuario.nombre) || activadorEtiqueta(usuario, key)) })
  }
  for (const [key, entry] of activadores) {
    const usuario = usuariosPorId.value.get(key.startsWith('uid:') ? key.slice(4) : '')
    if (usuario) entry.nombre = etiquetaConEstado(usuario, entry.nombre)
  }
  // Unión con el catálogo funcional confirmado: agrega tipos oficiales aunque no
  // tengan filas (seleccionarlos muestra cero). Los históricos presentes en datos
  // se conservan; las categorías del catálogo no se fusionan (no son campo).
  for (const funcional of TIPOS_FUNCIONALES) {
    const key = tipoKey({ tipo_activacion: funcional.tecnico })
    if (key === 'none') continue
    const existente = tipos.get(key)
    if (existente) { existente.nombre = funcional.nombre; continue }
    tipos.set(key, { key, nombre: funcional.nombre })
  }
  // Unión con el catálogo autorizado: agrega líderes activos sin activaciones y
  // anota el estado de los líderes actuales inhabilitados si el catálogo lo informa.
  for (const [id, catalogado] of catalogoLideres.value) {
    const key = `lid:${id}`
    const existente = lideres.get(key)
    if (existente) {
      if (catalogado.estado !== 'activo' && !/\(inhabilitado\)$/i.test(existente.nombre)) {
        existente.nombre = `${existente.nombre} (inhabilitado)`
      }
      continue
    }
    if (catalogado.estado !== 'activo' || !catalogado.nombre) continue
    lideres.set(key, { key, nombre: catalogado.nombre })
  }
  const ordenar = (entries) => [...entries].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  const ordenarEquipos = (entries) => [...entries].sort((a, b) => {
    const numeroA = a.nombre.match(/^Equipo #(\d+)/)?.[1]
    const numeroB = b.nombre.match(/^Equipo #(\d+)/)?.[1]
    if (numeroA && numeroB) return Number(numeroA) - Number(numeroB)
    if (numeroA) return -1
    if (numeroB) return 1
    if (a.nombre === 'Sin equipo') return 1
    if (b.nombre === 'Sin equipo') return -1
    return a.nombre.localeCompare(b.nombre, 'es')
  })
  return { plazas: ordenar(plazas.values()), activadores: ordenar(activadores.values()), tipos: ordenar(tipos.values()), lideres: ordenar(lideres.values()), equipos: ordenarEquipos(equipos.values()) }
})

const dashboard = computed(() => {
  const rows = [], points = []
  const maps = { dia: new Map(), semana: new Map(), mes: new Map(), plaza: new Map(), activador: new Map(), tipo: new Map(), lider: new Map(), clasificacion: new Map(), errores: new Map() }
  const kpis = { total: 0, hoy: 0, semana: 0, mes: 0, cashIn: 0, errores: 0, tiendas: 0, comercios: 0 }
  // Ventana de promedios: sin fechas, mes actual hasta hoy (America/La_Paz);
  // con fechas, el intervalo seleccionado sin incluir días futuros.
  const periodoDesde = filtroDesde.value || `${monthKey}-01`
  const periodoHastaSel = filtroHasta.value || todayKey
  const periodoHasta = periodoHastaSel > todayKey ? todayKey : periodoHastaSel
  const teamStats = new Map()
  const teamMonthStats = new Map()
  const activadoresUnicos = new Set()
  const nombresPlaza = new Map([['none', SIN_CIUDAD_REGISTRADA]]), nombresActivador = new Map([['none', 'Sin activador']]), nombresTipo = new Map([['none', 'Sin especificar'], ...TIPOS_FUNCIONALES.map((t) => [tipoKey({ tipo_activacion: t.tecnico }), t.nombre])]), nombresLider = new Map()
  for (const item of activaciones.value) {
    const fecha = fechaRegistro(item)
    const plaza = plazaKey(item)
    const plazaDisplay = plazaEtiqueta(item)
    const activador = activadorKey(item)
    const activadorDisplay = activadorEtiqueta(item, activador)
    const tipo = tipoKey(item)
    const lider = liderKey(item)
    const liderDisplay = liderEtiqueta(item, lider)
    const equipo = equipoKey(item)
    const equipoNombre = equipoEtiqueta(item, equipo)
    const comercio = comercioRegistro(item)
    const clasificacion = clasificacionRegistro(item)
    if (filtroDesde.value && (!fecha || fecha < filtroDesde.value)) continue
    if (filtroHasta.value && (!fecha || fecha > filtroHasta.value)) continue
    if (filtroPlaza.value && plaza !== filtroPlaza.value) continue
    if (filtroActivador.value && activador !== filtroActivador.value) continue
    if (filtroTipo.value && tipo !== filtroTipo.value) continue
    if (filtroLider.value && lider !== filtroLider.value) continue
    if (filtroEquipo.value && equipo !== filtroEquipo.value) continue
    rows.push(item)
    if (activador !== 'none') activadoresUnicos.add(activador)
    if (!nombresPlaza.has(plaza)) nombresPlaza.set(plaza, plazaDisplay)
    if (!nombresActivador.has(activador)) nombresActivador.set(activador, activadorDisplay)
    if (tipo !== 'none' && !nombresTipo.has(tipo)) nombresTipo.set(tipo, texto(item.tipo_activacion))
    if (lider !== 'none' && !nombresLider.has(lider)) nombresLider.set(lider, liderDisplay)
    if (tipo === 'comercio') kpis.comercios += 1
    kpis.total += 1
    if (fecha === todayKey) kpis.hoy += 1
    if (fecha >= weekStartKey && fecha <= todayKey) kpis.semana += 1
    if (fecha.startsWith(monthKey)) kpis.mes += 1
    if (item.cash_in === true) kpis.cashIn += 1
    if (item.hubo_error === true) kpis.errores += 1
    if (clasificacion === 'Barrio') kpis.tiendas += 1
    sumar(maps.dia, fecha || 'Sin fecha'); sumar(maps.semana, weekRegistro(fecha)); sumar(maps.mes, monthRegistro(fecha)); sumar(maps.plaza, plaza); sumar(maps.activador, activador); sumar(maps.tipo, tipo)
    sumar(maps.clasificacion, clasificacion)
    sumar(maps.errores, item.hubo_error === true ? 'Con error' : 'Sin error')
    if (lider !== 'none') sumar(maps.lider, lider)
    const team = teamStats.get(equipo) ?? { nombre: equipoNombre, total: 0, errores: 0, integrantes: new Set() }
    team.total += 1; if (item.hubo_error === true) team.errores += 1; team.integrantes.add(activador); teamStats.set(equipo, team)
    const teamMonthKey = `${equipo}__${monthRegistro(fecha)}`
    const teamMonth = teamMonthStats.get(teamMonthKey) ?? { equipo: equipoNombre, mes: monthRegistro(fecha), total: 0, activadores: new Set(), errores: 0, comercios: new Set() }
    teamMonth.total += 1; teamMonth.activadores.add(activador); if (item.hubo_error === true) teamMonth.errores += 1; if (comercio) teamMonth.comercios.add(normalizado(comercio))
    teamMonthStats.set(teamMonthKey, teamMonth)
    const hasCoordinates = item.latitud !== null && item.latitud !== undefined && item.latitud !== '' && item.longitud !== null && item.longitud !== undefined && item.longitud !== ''
    const lat = Number(item.latitud), lng = Number(item.longitud)
    if (hasCoordinates && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) points.push({ lat, lng, label: `${activadorDisplay} · ${plazaDisplay}` })
  }
  const porEquipo = [...teamStats.values()].map((team) => ({
    nombre: team.nombre, total: team.total, integrantes: team.integrantes.size,
    promedio: team.integrantes.size ? team.total / team.integrantes.size : 0,
    errores: team.errores, cumplimiento: team.total ? ((team.total - team.errores) / team.total) * 100 : 0,
  })).sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre, 'es'))
  const resumenEquipoMes = [...teamMonthStats.values()].map((item) => ({
    equipo: item.equipo,
    mes: item.mes,
    total: item.total,
    activadores: item.activadores.size,
    comercios: item.comercios.size,
    errores: item.errores,
  })).sort((a, b) => b.mes.localeCompare(a.mes) || b.total - a.total || a.equipo.localeCompare(b.equipo, 'es'))
  const diasPeriodo = diasEntre(periodoDesde, periodoHasta)
  const promedios = {
    diario: maps.dia.size ? kpis.total / maps.dia.size : 0,
    semanal: maps.semana.size ? kpis.total / maps.semana.size : 0,
    mensual: maps.mes.size ? kpis.total / maps.mes.size : 0,
    // Promedios por días calendario (incluye días sin activaciones).
    calendarioDiario: diasPeriodo > 0 ? kpis.total / diasPeriodo : 0,
    calendarioSemanal: diasPeriodo > 0 ? kpis.total / (diasPeriodo / 7) : 0,
    diasPeriodo,
    periodoDesde,
    periodoHasta,
  }
  const traducir = (entries, nombres) => entries.map((entry) => ({ key: entry.label, label: nombres.get(entry.label) ?? entry.label, value: entry.value }))
  const rankingActivadores = new Map()
  for (const usuario of integrantesRanking.value) {
    const key = activadorKey(usuario)
    rankingActivadores.set(key, {
      key,
      label: etiquetaConEstado(usuario, texto(usuario.nombre) || nombresActivador.get(key) || activadorEtiqueta(usuario, key)),
      value: maps.activador.get(key) ?? 0,
    })
  }
  for (const [key, value] of maps.activador) {
    if (key === 'none') continue
    const existente = rankingActivadores.get(key)
    if (existente) { existente.value = value; continue }
    const usuario = usuariosPorId.value.get(key.slice(4))
    const base = nombresActivador.get(key) ?? activadorCatalogo.value.get(key.slice(4)) ?? `Activador · ${key.slice(4, 12)}`
    rankingActivadores.set(key, { key, label: etiquetaConEstado(usuario, base), value })
  }
  const topActivadores = [...rankingActivadores.values()]
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'es') || a.key.localeCompare(b.key))
  return { rows, points, kpis, promedios, activadoresUnicos: activadoresUnicos.size, porEquipo, resumenEquipoMes, porDia: ranking(maps.dia).sort((a, b) => a.label.localeCompare(b.label)), porPlaza: traducir(ranking(maps.plaza), nombresPlaza), topActivadores, porTipo: traducir(ranking(maps.tipo), nombresTipo), porClasificacion: ranking(maps.clasificacion), porErrores: ranking(maps.errores), topLideres: traducir(ranking(maps.lider, 10), nombresLider) }
})

const equipoMesHeatmap = computed(() => {
  const meses = [...new Set(dashboard.value.resumenEquipoMes.map((item) => item.mes))].sort((a, b) => a.localeCompare(b))
  const equipos = new Map()
  const totals = Object.fromEntries(meses.map((mes) => [mes, 0]))
  let grandTotal = 0
  let max = 0
  for (const item of dashboard.value.resumenEquipoMes) {
    const equipo = equipos.get(item.equipo) ?? { equipo: item.equipo, byMonth: Object.fromEntries(meses.map((mes) => [mes, 0])), total: 0 }
    equipo.byMonth[item.mes] = (equipo.byMonth[item.mes] ?? 0) + item.total
    equipo.total += item.total
    totals[item.mes] = (totals[item.mes] ?? 0) + item.total
    grandTotal += item.total
    max = Math.max(max, equipo.byMonth[item.mes])
    equipos.set(item.equipo, equipo)
  }
  const rows = [...equipos.values()]
    .map((item) => ({ equipo: item.equipo, values: meses.map((mes) => ({ mes, value: item.byMonth[mes] ?? 0 })), total: item.total }))
    .sort((a, b) => b.total - a.total || a.equipo.localeCompare(b.equipo, 'es'))
  return { meses, rows, totals, grandTotal, max }
})

const rankingTotalPages = computed(() => Math.max(1, Math.ceil(dashboard.value.topActivadores.length / rankingPageSize)))
const rankingSafePage = computed(() => Math.min(rankingPage.value, rankingTotalPages.value))
const rankingPaginado = computed(() => {
  const start = (rankingSafePage.value - 1) * rankingPageSize
  return dashboard.value.topActivadores.slice(start, start + rankingPageSize)
})
const rankingStartIndex = computed(() => (rankingSafePage.value - 1) * rankingPageSize)

const lineChart = computed(() => {
  const data = dashboard.value.porDia
  const width = 920, height = 260, padX = 42, padY = 28
  const max = Math.max(1, ...data.map((item) => item.value))
  const step = data.length > 1 ? (width - padX * 2) / (data.length - 1) : 0
  const points = data.map((item, index) => {
    const x = data.length > 1 ? padX + index * step : width / 2
    const y = height - padY - (item.value / max) * (height - padY * 2)
    return { ...item, x, y }
  })
  return { width, height, points, polyline: points.map((point) => `${point.x},${point.y}`).join(' '), max }
})

const tarjetas = computed(() => [
  { key: 'total', icon: '◎', label: 'Activaciones totales', value: formatNumber(dashboard.value.kpis.total), note: 'Registros filtrados' },
  { key: 'hoy', icon: '◷', label: 'Hoy', value: formatNumber(dashboard.value.kpis.hoy), note: todayKey },
  { key: 'semana', icon: '▦', label: 'Semana', value: formatNumber(dashboard.value.kpis.semana), note: `Desde ${formatDate(weekStartKey)}` },
  { key: 'mes', icon: '□', label: 'Mes', value: formatNumber(dashboard.value.kpis.mes), note: formatMonth(monthKey) },
  { key: 'promedio-diario', icon: '∿', label: 'Promedio diario', value: formatPromedio(dashboard.value.promedios.calendarioDiario), note: `${dashboard.value.promedios.diasPeriodo} días calendario` },
  { key: 'promedio-semanal', icon: '∿', label: 'Promedio semanal', value: formatPromedio(dashboard.value.promedios.calendarioSemanal), note: `Sobre ${dashboard.value.promedios.diasPeriodo} días` },
  { key: 'errores', icon: '!', label: 'Errores', value: formatNumber(dashboard.value.kpis.errores), note: 'Registros con error' },
  { key: 'tiendas', icon: '⌂', label: 'Tiendas', value: formatNumber(dashboard.value.kpis.tiendas), note: 'Clasificación barrio' },
  { key: 'comercios', icon: '⌂', label: 'Comercios', value: formatNumber(dashboard.value.kpis.comercios), note: 'Registros con tipo comercio' },
])
const hayFiltros = computed(() => Boolean(filtroDesde.value || filtroHasta.value || filtroPlaza.value || filtroActivador.value || filtroTipo.value || filtroLider.value || filtroEquipo.value))
function limpiarFiltros() { filtroDesde.value = ''; filtroHasta.value = ''; filtroPlaza.value = ''; filtroActivador.value = ''; filtroTipo.value = ''; filtroLider.value = ''; filtroEquipo.value = '' }
function anchoBarra(value, values) { const max = Math.max(1, ...values.map((item) => item.value)); return `${Math.max(3, (value / max) * 100)}%` }
function barHeight(value, values) { const max = Math.max(1, ...values.map((item) => item.value)); return `${Math.max(8, (value / max) * 100)}%` }
function heatCellStyle(value) {
  const max = Math.max(1, equipoMesHeatmap.value.max)
  const ratio = Number(value) > 0 ? Number(value) / max : 0
  const opacity = ratio ? 0.16 + ratio * 0.64 : 0.04
  return { background: `rgba(23, 105, 255, ${opacity})`, color: ratio > 0.55 ? '#ffffff' : '#143b5e' }
}
function porcentajeDelTotal(value) { return dashboard.value.kpis.total ? `${formatDecimal((Number(value) / dashboard.value.kpis.total) * 100)}%` : '0%' }
function rankingAnterior() { rankingPage.value = Math.max(1, rankingSafePage.value - 1) }
function rankingSiguiente() { rankingPage.value = Math.min(rankingTotalPages.value, rankingSafePage.value + 1) }
function exportarDashboard() {
  if (!dashboard.value.rows.length) return
  const escape = (value) => `"${String(neutralizeSpreadsheetFormula(value) ?? '').replace(/"/g, '""')}"`
  const data = dashboard.value.rows.map((item) => [fechaRegistro(item), texto(item.impulsador), plazaRegistro(item), texto(item.tipo_activacion), item.cash_in === true ? 'Si' : 'No', item.hubo_error === true ? 'Si' : 'No'].map(escape).join(','))
  const blob = new Blob([`\uFEFF${[['Fecha', 'Activador', 'Ciudad', 'Tipo', 'Cash-In', 'Error'].map(escape).join(','), ...data].join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'dashboard-activaciones.csv'; link.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="view-page metrics-saas">
    <header class="metrics-saas-header"><div class="metrics-heading"><p class="view-kicker">Inteligencia Operativa</p><h1 class="view-title">Dashboard de Activaciones</h1><p class="view-description">Una vista clara del volumen, cobertura y desempeño del equipo en campo.</p></div><button class="boton boton-primario" :disabled="loading || !dashboard.rows.length" @click="exportarDashboard">Exportar</button></header>
    <section class="metrics-filter-card"><div class="metrics-filter-head"><div><h2>Filtros</h2><p>{{ formatNumber(dashboard.rows.length) }} de {{ formatNumber(activaciones.length) }} registros</p></div><button class="boton" :disabled="!hayFiltros" @click="limpiarFiltros">Limpiar</button></div><div class="filtros metrics-filter-grid">
      <label><span class="field-label">Fecha desde</span><input v-model="filtroDesde" type="date" class="input-texto"></label><label><span class="field-label">Fecha hasta</span><input v-model="filtroHasta" type="date" class="input-texto"></label>
      <label><span class="field-label">Ciudad de activación</span><select v-model="filtroPlaza" class="input-texto"><option value="">Todas</option><option v-for="plaza in opciones.plazas" :key="plaza.key" :value="plaza.key">{{ plaza.nombre }}</option></select></label>
      <label><span class="field-label">Activador</span><select v-model="filtroActivador" class="input-texto"><option value="">Todos</option><option v-for="activador in opciones.activadores" :key="activador.key" :value="activador.key">{{ activador.nombre }}</option></select></label>
      <label><span class="field-label">Equipo</span><select v-model="filtroEquipo" class="input-texto"><option value="">Todos</option><option v-for="equipo in opciones.equipos" :key="equipo.key" :value="equipo.key">{{ equipo.nombre }}</option></select></label>
      <label v-if="opciones.lideres.length"><span class="field-label">Líder de registro</span><select v-model="filtroLider" class="input-texto"><option value="">Todos</option><option v-for="lider in opciones.lideres" :key="lider.key" :value="lider.key">{{ lider.nombre }}</option></select></label>
      <label><span class="field-label">Tipo de activación</span><select v-model="filtroTipo" class="input-texto"><option value="">Todos</option><option v-for="tipo in opciones.tipos" :key="tipo.key" :value="tipo.key">{{ tipo.nombre }}</option></select></label>
    </div></section>
    <p v-if="loading" class="panel-empty">Cargando indicadores...</p><p v-else-if="errorMsg" class="mensaje-error">{{ errorMsg }}</p><p v-else-if="!dashboard.rows.length && !dashboard.topActivadores.length" class="panel-empty">No hay activaciones para los filtros seleccionados.</p>
    <div v-else class="metrics-saas-content">
      <section class="metrics-kpi-grid metrics-kpi-grid-compact"><article v-for="card in tarjetas" :key="card.key" class="metrics-kpi-card" :title="`${card.label}: ${card.value}`"><span class="metrics-kpi-icon">{{ card.icon }}</span><div><p class="metrics-kpi-label">{{ card.label }}</p><p class="metrics-kpi-value">{{ card.value }}</p><p class="metrics-kpi-note">{{ card.note }}</p></div></article></section>
      <section class="metrics-line-grid">
        <article class="metrics-chart-card metrics-line-card"><h3>Activaciones por Fecha</h3><p>Evolución diaria del periodo filtrado.</p><div class="chart-legend"><span class="legend-dot"></span><span>Activaciones filtradas</span></div><div class="metrics-line-wrap"><svg class="metrics-line-svg" :viewBox="`0 0 ${lineChart.width} ${lineChart.height}`" role="img" aria-label="Activaciones por fecha"><g class="line-grid"><line v-for="n in 5" :key="n" x1="42" :y1="28 + (n - 1) * 51" x2="878" :y2="28 + (n - 1) * 51"></line></g><polyline v-if="lineChart.points.length" :points="lineChart.polyline" fill="none" stroke="var(--ru-primary)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"></polyline><g v-for="point in lineChart.points" :key="point.label"><title>{{ formatDate(point.label) }}: {{ formatNumber(point.value) }} activaciones</title><circle :cx="point.x" :cy="point.y" r="4.5" fill="var(--ru-primary)"></circle><text :x="point.x" :y="point.y - 9" text-anchor="middle">{{ point.value }}</text><text class="line-date" :x="point.x" y="246" text-anchor="middle">{{ formatShortDate(point.label) }}</text></g></svg></div></article>
      </section>
      <section class="metrics-four-grid">
        <article class="metrics-chart-card metrics-small-chart"><h3>Activaciones por Tipo</h3><p>Todos los tipos registrados.</p><div class="chart-legend"><span class="legend-dot"></span><span>Tipos filtrados</span></div><div class="vertical-bars adaptive-bars" :style="{ '--items': dashboard.porTipo.length }"><div v-for="item in dashboard.porTipo" :key="item.label" class="vertical-bar" :title="`${item.label}: ${formatNumber(item.value)} activaciones`"><strong>{{ formatNumber(item.value) }}</strong><span :style="{ height: barHeight(item.value, dashboard.porTipo) }"></span><small>{{ item.label }}</small></div></div></article>
        <article class="metrics-chart-card metrics-small-chart"><h3>Ciudades</h3><p>Distribución por ciudad de activación.</p><div class="chart-legend"><span class="legend-dot"></span><span>Top 10</span></div><div class="vertical-bars city-bars"><div v-for="item in dashboard.porPlaza.slice(0, 10)" :key="item.label" class="vertical-bar" :title="`${item.label}: ${formatNumber(item.value)} activaciones`"><strong>{{ formatNumber(item.value) }}</strong><span :style="{ height: barHeight(item.value, dashboard.porPlaza) }"></span><small>{{ item.label }}</small></div></div></article>
        <article class="metrics-chart-card metrics-small-chart"><h3>Equipos</h3><p>Top equipos por activaciones.</p><div class="dashboard-bars compact-bars"><div v-for="team in dashboard.porEquipo.slice(0, 8)" :key="team.nombre" class="dashboard-bar-row" :title="`${team.nombre}: ${formatNumber(team.total)} activaciones`"><span>{{ team.nombre }}</span><div class="metric-track"><div class="metric-fill metric-fill-soft" :style="{ width: anchoBarra(team.total, dashboard.porEquipo.map((item) => ({ value: item.total }))) }"></div></div><strong>{{ formatNumber(team.total) }}</strong></div></div></article>
        <article class="metrics-chart-card metrics-small-chart"><h3>Líderes</h3><p>Activaciones de integrantes del equipo actual.</p><div v-if="dashboard.topLideres.length" class="dashboard-bars compact-bars"><div v-for="item in dashboard.topLideres.slice(0, 8)" :key="item.label" class="dashboard-bar-row" :title="`${item.label}: ${formatNumber(item.value)} activaciones`"><span>{{ item.label }}</span><div class="metric-track"><div class="metric-fill" :style="{ width: anchoBarra(item.value, dashboard.topLideres) }"></div></div><strong>{{ formatNumber(item.value) }}</strong></div></div><p v-else class="metrics-empty-small">Sin líderes resolubles.</p></article>
        <article class="metrics-chart-card metrics-small-chart"><h3>Errores</h3><p>Activaciones con y sin error.</p><div class="dashboard-bars compact-bars"><div v-for="item in dashboard.porErrores" :key="item.label" class="dashboard-bar-row" :title="`${item.label}: ${formatNumber(item.value)} activaciones`"><span>{{ item.label }}</span><div class="metric-track"><div class="metric-fill" :style="{ width: anchoBarra(item.value, dashboard.porErrores) }"></div></div><strong>{{ formatNumber(item.value) }}</strong></div></div></article>
      </section>
      <section class="metrics-bottom-grid">
        <article class="metrics-chart-card metrics-table-card"><h3>Resumen Equipo y Activadores</h3><p>Matriz de activaciones por equipo y mes del rango filtrado.</p><div class="table-wrap metrics-table-scroll heatmap-table-wrap"><table class="tabla-activaciones metrics-heat-table"><thead><tr><th class="sticky-col">Equipo</th><th v-for="mes in equipoMesHeatmap.meses" :key="mes">{{ formatMonth(mes) }}</th><th>Total</th></tr></thead><tbody><tr v-for="row in equipoMesHeatmap.rows" :key="row.equipo"><td class="sticky-col heat-team-name">{{ row.equipo }}</td><td v-for="cell in row.values" :key="`${row.equipo}-${cell.mes}`" class="heat-cell" :style="heatCellStyle(cell.value)" :title="`${row.equipo} · ${formatMonth(cell.mes)}: ${formatNumber(cell.value)} activaciones`">{{ formatNumber(cell.value) }}</td><td class="heat-total">{{ formatNumber(row.total) }}</td></tr></tbody><tfoot><tr><th class="sticky-col">Total</th><td v-for="mes in equipoMesHeatmap.meses" :key="`total-${mes}`" class="heat-total">{{ formatNumber(equipoMesHeatmap.totals[mes]) }}</td><td class="heat-grand-total">{{ formatNumber(equipoMesHeatmap.grandTotal) }}</td></tr></tfoot></table></div></article>
        <article class="metrics-chart-card metrics-table-card"><h3>Ranking Activadores</h3><p>Ordenado por activaciones del corte filtrado.</p><div class="table-wrap metrics-table-scroll ranking-table-wrap"><table class="tabla-activaciones metrics-ranking-table"><thead><tr><th>#</th><th>Activador</th><th>Activaciones</th><th>%</th></tr></thead><tbody><tr v-for="(item, index) in rankingPaginado" :key="item.key" :title="`${item.label}: ${formatNumber(item.value)} activaciones · ${porcentajeDelTotal(item.value)}`"><td>{{ rankingStartIndex + index + 1 }}</td><td>{{ item.label }}</td><td><div class="ranking-activation-cell"><span class="ranking-fill" :style="{ width: item.value ? anchoBarra(item.value, dashboard.topActivadores) : '0%' }"></span><strong>{{ formatNumber(item.value) }}</strong></div></td><td class="ranking-percent">{{ porcentajeDelTotal(item.value) }}</td></tr></tbody></table></div><div v-if="dashboard.topActivadores.length > rankingPageSize" class="ranking-pagination"><button class="boton boton-pequeno" :disabled="rankingSafePage <= 1" @click="rankingAnterior">Anterior</button><span>{{ rankingStartIndex + 1 }}-{{ Math.min(rankingStartIndex + rankingPageSize, dashboard.topActivadores.length) }} / {{ formatNumber(dashboard.topActivadores.length) }}</span><button class="boton boton-pequeno" :disabled="rankingSafePage >= rankingTotalPages" @click="rankingSiguiente">Siguiente</button></div></article>
      </section>
      <article class="metrics-chart-card metrics-map-card"><div class="metrics-card-heading"><div><h3>Mapa de calor</h3><p>Concentración geográfica de activaciones.</p></div><span class="meta-pill">{{ formatNumber(dashboard.points.length) }} puntos</span></div><MetricsHeatMap v-if="dashboard.points.length" :points="dashboard.points" /><p v-else class="panel-empty">No hay coordenadas válidas para este corte.</p></article>
    </div>
  </section>
</template>

<style scoped>
.metrics-saas-content {
  gap: 1rem;
}

.metrics-kpi-grid-compact {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1rem;
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-card) {
  min-height: 116px;
  height: 116px;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  padding: 0.85rem;
  border-radius: 14px;
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-icon) {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  font-size: 1rem;
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-value) {
  font-size: clamp(1.55rem, 1.9vw, 2rem);
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-label),
.metrics-kpi-grid-compact :deep(.metrics-kpi-note) {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-label) {
  -webkit-line-clamp: 2;
}

.metrics-kpi-grid-compact :deep(.metrics-kpi-note) {
  -webkit-line-clamp: 1;
}

.metrics-line-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  align-items: stretch;
  min-width: 0;
}

.metrics-four-grid,
.metrics-bottom-grid {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

.metrics-four-grid {
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  align-items: stretch;
}

.metrics-bottom-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
}

.metrics-chart-card {
  padding: 1rem;
  border-radius: 14px;
}

.metrics-chart-card h3 {
  margin: 0;
  color: #143b5e;
  font-size: 1rem;
  font-weight: 900;
  line-height: 1.2;
}

.metrics-chart-card > p,
.metrics-card-heading p {
  margin: 0.25rem 0 0;
  color: #55728e;
  font-size: 0.78rem;
  line-height: 1.3;
}

.metrics-line-card {
  min-height: 360px;
  display: flex;
  flex-direction: column;
}

.metrics-line-wrap {
  flex: 1;
  min-height: 250px;
  margin-top: 1rem;
  overflow-x: auto;
  border: 1px solid #d8e4ef;
  border-radius: 12px;
  background: #fbfdff;
}

.metrics-line-svg {
  display: block;
  width: 100%;
  min-width: 720px;
  height: 100%;
  min-height: 250px;
}

.metrics-line-svg text {
  fill: var(--ru-primary);
  font-size: 12px;
  font-weight: 700;
}

.metrics-line-svg .line-date {
  fill: #55728e;
  font-size: 11px;
  font-weight: 600;
}

.line-grid line {
  stroke: #c7d3df;
  stroke-width: 1;
}

.chart-legend {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.65rem;
  color: #55728e;
  font-size: 0.72rem;
  font-weight: 700;
}

.legend-dot {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 999px;
  background: var(--ru-primary);
}

.legend-dot-soft {
  background: var(--ru-primary-strong);
}

.metrics-type-card,
.metrics-small-chart {
  min-height: 300px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.metrics-type-card {
  min-height: 300px;
}

.metrics-small-chart {
  height: 300px;
}

.compact-chart {
  min-height: 220px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.compact-bars {
  flex: 1;
  max-height: 190px;
  overflow: auto;
  padding-right: 0.2rem;
}

.vertical-bars {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(58px, 1fr);
  align-items: end;
  gap: 0.6rem;
  flex: 1;
  min-height: 160px;
  height: 160px;
  margin-top: 1rem;
  padding: 0.5rem 0.2rem 0;
  overflow-x: auto;
  border-bottom: 1px solid #c7d3df;
}

.adaptive-bars {
  grid-auto-columns: minmax(64px, 1fr);
  min-height: min(210px, max(160px, calc(110px + var(--items, 1) * 4px)));
}

.vertical-bar {
  display: grid;
  grid-template-rows: 22px 1fr 34px;
  align-items: end;
  justify-items: center;
  min-width: 0;
  height: 100%;
  color: #24496d;
}

.vertical-bar span {
  width: 72%;
  min-height: 8px;
  border-radius: 7px 7px 0 0;
  background: linear-gradient(180deg, var(--ru-primary) 0%, var(--ru-primary-strong) 100%);
}

.vertical-bar strong {
  color: #6a849c;
  font-size: 0.72rem;
  line-height: 1;
}

.vertical-bar small {
  align-self: start;
  max-width: 76px;
  overflow: hidden;
  color: #55728e;
  font-size: 0.68rem;
  line-height: 1.1;
  text-align: center;
  text-overflow: ellipsis;
}

.city-bars {
  height: 160px;
}

.metrics-table-card {
  height: 430px;
  display: flex;
  flex-direction: column;
}

.metrics-table-scroll {
  flex: 1;
  min-height: 0;
  margin-top: 1rem;
  overflow: auto;
  border: 1px solid #d8e4ef;
  border-radius: 12px;
}

.metrics-table-scroll :deep(table) {
  min-width: 620px;
}

.metrics-table-scroll :deep(thead th) {
  position: sticky;
  top: 0;
  z-index: 1;
}

.heatmap-table-wrap {
  overflow: auto;
}

.metrics-heat-table {
  min-width: 760px;
  border-collapse: separate;
  border-spacing: 0;
}

.metrics-heat-table th,
.metrics-heat-table td {
  min-width: 96px;
  text-align: center;
  white-space: nowrap;
}

.metrics-heat-table .sticky-col {
  position: sticky;
  left: 0;
  z-index: 2;
  min-width: 150px;
  text-align: left;
  background: #f7fbff;
  box-shadow: 1px 0 0 #d8e4ef;
}

.metrics-heat-table thead .sticky-col {
  z-index: 3;
  background: #edf6ff;
}

.heat-team-name {
  color: #143b5e;
  font-weight: 800;
}

.heat-cell {
  border-radius: 8px;
  font-weight: 800;
}

.heat-total,
.heat-grand-total {
  color: #143b5e;
  font-weight: 900;
  background: #eaf3fb;
}

.metrics-heat-table tfoot th,
.metrics-heat-table tfoot td {
  position: sticky;
  bottom: 0;
  z-index: 1;
  border-top: 2px solid var(--ru-primary);
}

.metrics-ranking-table {
  min-width: 440px;
}

.metrics-ranking-table th:first-child,
.metrics-ranking-table td:first-child {
  width: 52px;
  text-align: center;
}

.ranking-percent {
  color: #55728e;
  font-weight: 900;
  text-align: right;
  white-space: nowrap;
}

.ranking-activation-cell {
  position: relative;
  min-width: 116px;
  overflow: hidden;
  border-radius: 10px;
  background: #eef5fb;
  color: #143b5e;
}

.ranking-activation-cell strong {
  position: relative;
  z-index: 1;
  display: block;
  padding: 0.35rem 0.55rem;
  text-align: right;
}

.ranking-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(23, 105, 255, 0.36), rgba(15, 141, 245, 0.62));
}

.ranking-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding-top: 0.75rem;
  color: #55728e;
  font-size: 0.78rem;
  font-weight: 800;
}

.ranking-pagination .boton-pequeno {
  min-height: 32px;
  padding: 0.35rem 0.7rem;
  font-size: 0.72rem;
}

.metrics-map-card {
  grid-column: 1 / -1;
}

@media (max-width: 1100px) {
  .metrics-kpi-grid-compact {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metrics-bottom-grid {
    grid-template-columns: 1fr;
  }

  .metrics-four-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metrics-line-card {
    min-height: 360px;
  }

  .metrics-line-wrap,
  .metrics-line-svg {
    min-height: 240px;
  }
}

@media (max-width: 720px) {
  .metrics-kpi-grid-compact,
  .metrics-four-grid {
    grid-template-columns: 1fr;
  }

  .metrics-kpi-grid-compact :deep(.metrics-kpi-card) {
    min-height: 104px;
    height: 104px;
  }

  .metrics-line-card,
  .metrics-type-card,
  .metrics-small-chart,
  .compact-chart {
    min-height: auto;
  }

  .metrics-line-wrap,
  .metrics-line-svg {
    min-height: 280px;
  }

  .vertical-bars {
    grid-auto-columns: minmax(62px, 72px);
  }

  .metrics-table-card {
    height: 360px;
  }
}
</style>
