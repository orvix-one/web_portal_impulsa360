<script setup>
import { computed, ref, onBeforeUnmount, onMounted, watch } from 'vue'
import { adminApiRequest } from '../lib/adminApiClient'
import { fetchActivacionDetalle, fetchActivacionesExportacion } from '../lib/activacionesService'
import {
  notifyError,
  notifyInfo,
  notifySuccess,
  notifyWarning,
  requestPasswordConfirmation,
} from '../lib/feedback'
import { isValidEmail, normalizeEmail, normalizeText } from '../lib/textUtils'
import { useAuth } from '../lib/authStore'
import { AUTH_ENABLED } from '../lib/featureFlags'
import { etiquetaCiudadActivacion } from '../lib/plazas'
import { neutralizeExportRow, neutralizeSpreadsheetFormula } from '../lib/exportSafety'
import { logClientError } from '../lib/logging'
import {
  ACTIVATION_CATEGORIES,
  ACTIVATION_ERROR_TYPES,
  ACTIVATION_TYPES_BY_CATEGORY,
  COMMERCE_CATEGORIES,
  STORE_SIZES,
  inferActivationCategory,
  isCreditosEligible,
  isGeneralCommerce,
  isRemesasEligible,
  normalizeActivationClassification,
  validateActivationEdit,
  validateActivationTextLengths,
} from '../lib/activationEditing'

const props = defineProps({
  activaciones: {
    type: Array,
    default: () => [],
  },
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 50 },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['activacion-eliminada', 'activacion-actualizada', 'filtrar', 'cambiar-pagina'])

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')
const boliviaDateTimeFormatter = new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/La_Paz',
})
const boliviaTimeFormatter = new Intl.DateTimeFormat('es-BO', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'America/La_Paz',
})

const filtroPlaza = ref('')
const filtroDistrito = ref('')
const filtroImpulsador = ref('')
const filtroFechaDesde = ref('')
const filtroFechaHasta = ref('')
const exportandoExcel = ref(false)
const deletingActivationId = ref(null)
const activacionSeleccionada = ref(null)
const editandoActivacion = ref(false)
const guardandoEdicion = ref(false)
const reemplazandoFoto = ref('')
const fotoPrincipalArchivo = ref(null)
const fotoCashInArchivo = ref(null)
const inputFotoPrincipal = ref(null)
const inputFotoCashIn = ref(null)
const formularioEdicion = ref({})
const formularioEdicionInicial = ref({})
const motivoEdicion = ref('')
const { session, profile, isAdmin } = useAuth()
const canAdminister = computed(() => !AUTH_ENABLED || isAdmin.value)
const hasAdminRole = computed(() =>
  profile.value?.rol === 'administrador' || profile.value?.roles?.includes('administrador')
)
const canEditActivaciones = computed(() =>
  Boolean(session.value?.access_token && (!AUTH_ENABLED || hasAdminRole.value))
)

const opcionesOrg = ref({ available: false, plazas: [] })

async function cargarOpcionesOrg() {
  try {
    const result = await requestAdmin('/admin/organization-options')
    opcionesOrg.value = result
  } catch (err) {
    // no bloquear la edición si falla
    opcionesOrg.value = { available: false, plazas: [] }
  }
}

onMounted(() => { if (canEditActivaciones.value) cargarOpcionesOrg() })

function getCiudadActivacion(activacion) {
  return etiquetaCiudadActivacion(activacion)
}

function normalizeDateOnly(value) {
  const normalized = normalizeText(value)
  if (!normalized) {
    return ''
  }

  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : ''
}

// Los filtros se aplican en el servidor: la tabla muestra solo la pagina recibida.
const filas = computed(() => props.activaciones)
const totalPaginas = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const rangoVisible = computed(() => {
  if (!props.total) return '0'
  const desde = (props.page - 1) * props.pageSize + 1
  return `${desde}-${Math.min(props.total, desde + props.activaciones.length - 1)}`
})

function filtrosActuales() {
  return {
    plaza: filtroPlaza.value.trim(),
    distrito: filtroDistrito.value.trim(),
    impulsador: filtroImpulsador.value.trim(),
    fechaDesde: filtroFechaDesde.value,
    fechaHasta: filtroFechaHasta.value,
  }
}

let temporizadorFiltros = null
watch([filtroPlaza, filtroDistrito, filtroImpulsador, filtroFechaDesde, filtroFechaHasta], () => {
  clearTimeout(temporizadorFiltros)
  temporizadorFiltros = setTimeout(() => emit('filtrar', filtrosActuales()), 300)
})
onBeforeUnmount(() => clearTimeout(temporizadorFiltros))

function csvEscape(value) {
  if (value === null || value === undefined) {
    return ''
  }

  const normalized = String(neutralizeSpreadsheetFormula(value)).replace(/"/g, '""')

  if (/[";\r\n]/.test(normalized)) {
    return `"${normalized}"`
  }

  return normalized
}

function getFotoUrl(fotoUrl, signedUrl = '') {
  if (signedUrl) {
    return signedUrl
  }

  if (!fotoUrl || !/^https?:\/\//i.test(fotoUrl)) {
    return ''
  }

  return fotoUrl
}

function fotoHyperlinkCell(fotoUrl, signedUrl = '') {
  const url = getFotoUrl(fotoUrl, signedUrl)
  return url ? { text: 'Ver foto', hyperlink: url } : ''
}

function absoluteEvidenceUrl(relativePath) {
  if (!relativePath) {
    return ''
  }

  const base = String(apiBaseUrl || '/api').replace(/\/$/, '')
  const root = /^https?:\/\//i.test(base) ? base : `${window.location.origin}${base.startsWith('/') ? '' : '/'}${base}`
  return `${root}${relativePath.startsWith('/') ? '' : '/'}${relativePath}`
}

function evidenciaHyperlinkCell(relativePath) {
  const url = absoluteEvidenceUrl(relativePath)
  return url ? { text: 'Ver foto', hyperlink: url } : ''
}

function getFechaExcelDate(row) {
  const candidato = row?.created_at ?? row?.fecha_activacion ?? ''
  if (!candidato) return ''
  const fecha = candidato instanceof Date ? candidato : new Date(candidato)
  return Number.isNaN(fecha.getTime()) ? '' : fecha
}


function getRowKey(activacion, index) {
  return (
    activacion.id ??
    `${activacion.usuario_id ?? 'sin-usuario'}-${activacion.created_at ?? 'sin-fecha'}-${index}`
  )
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Se produjo un error inesperado.'
}

function formatCreatedAtBolivia(value, { emptyValue = '-' } = {}) {
  if (!value) {
    return emptyValue
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return boliviaDateTimeFormatter.format(date)
}

function formatHoraRegistro(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : boliviaTimeFormatter.format(date)
}

function formatFechaLegible(value) {
  const dateOnly = normalizeDateOnly(value)
  if (!dateOnly) return value ?? ''
  const [year, month, day] = dateOnly.split('-')
  return `${day}/${month}/${year}`
}

function tieneValor(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  return true
}

function esUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function etiquetaCampo(key) {
  const especiales = {
    id: 'ID del registro', usuario_id: 'ID del usuario', usuario_email: 'Correo del activador',
    created_at: 'Fecha de registro',
    fecha_activacion: 'Fecha de activacion', nombres_cliente: 'Nombres del cliente',
    apellidos_cliente: 'Apellidos del cliente', ci_cliente: 'CI del cliente',
    telefono_cliente: 'Telefono del cliente', email_cliente: 'Correo del cliente',
    ciudad_activacion: 'Ciudad de activacion', zona_activacion: 'Distrito o zona',
    plaza_base_registro: 'Plaza organizacional (base)',
    plaza_efectiva_registro: 'Plaza organizacional (efectiva)',
    plaza_temporal_registro: 'Plaza organizacional (temporal)',
    tipo_activacion: 'Tipo de activacion', tipo_comercio: 'Tipo de comercio',
    tamano_tienda: 'Tamano de tienda', foto_url: 'Fotografia', descargo_app: 'Descargo la app',
    cash_in: 'Cash-In', cash_out: 'Cash-Out', qr_fisico: 'QR fisico', p2p: 'P2P',
    hubo_error: 'Hubo error', descripcion_error: 'Descripcion del error',
    creditos: 'Créditos', remesas: 'Remesas',
  }
  return especiales[key] ?? key.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function formatearValor(value, key) {
  if (typeof value === 'boolean') return value ? 'Si' : 'No'
  if ((key.includes('fecha') || key.endsWith('_at')) && value) {
    if (key.endsWith('_at')) return formatCreatedAtBolivia(value)
    const dateOnly = normalizeDateOnly(value)
    if (dateOnly) {
      const [year, month, day] = dateOnly.split('-')
      return `${day}/${month}/${year}`
    }
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function valorBooleano(value) {
  return value == null ? '' : value ? 'Si' : 'No'
}

function primerValor(row, keys) {
  for (const key of keys) {
    if (tieneValor(row[key])) return row[key]
  }
  return ''
}

function normalizarTipoValor(value) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
}

function tipoNormalizado(row) {
  return `${normalizarTipoValor(row.tipo_activacion)} ${normalizarTipoValor(row.tipo_comercio)} ${normalizarTipoValor(row.tipo_tienda)} ${normalizarTipoValor(row.tamano_tienda)}`
}

function esTiendaBarrioRow(row) {
  const tipo = tipoNormalizado(row)
  return tipo.includes('tienda') || tipo.includes('barrio')
}

function esComercioRow(row) {
  return tipoNormalizado(row).includes('comercio')
}

function esTranseunteRow(row) {
  const tipo = tipoNormalizado(row)
  return tipo.includes('transeunte') || tipo.includes('transeúnte')
}

const seccionesDetalleConfig = [
  { title: 'Datos generales', keys: ['fecha_activacion', 'impulsador', 'ciudad_activacion', 'plaza', 'zona_activacion'] },
  { title: 'Plaza organizacional', keys: ['plaza_base_registro', 'plaza_efectiva_registro', 'plaza_temporal_registro'] },
  { title: 'Datos del cliente', keys: ['nombres_cliente', 'apellidos_cliente', 'ci_cliente', 'telefono_cliente', 'email_cliente'] },
  { title: 'Informacion de la activacion', keys: ['tipo_activacion', 'descargo_app', 'registro', 'cash_in', 'cash_out', 'p2p', 'qr_fisico', 'respaldo', 'creditos', 'remesas'] },
  { title: 'Informacion del comercio o tienda', keys: ['nombre_comercio', 'comercio', 'cliente', 'tipo_comercio', 'tamano_tienda', 'tipo_tienda', 'rubro_comercio', 'rubro_comercio_otro', 'comercio_fuera_mercado', 'es_plaza_temporal', 'plaza_temporal'] },
  { title: 'Evidencias y fotografias', keys: ['foto_url', 'foto_cash_in', 'foto_cashin'] },
  { title: 'Ubicacion', keys: ['latitud', 'longitud', 'direccion', 'ubicacion'] },
  { title: 'Errores u observaciones', keys: ['hubo_error', 'tipo_error', 'descripcion_error', 'observaciones'] },
  { title: 'Informacion tecnica del registro', keys: ['id', 'usuario_email', 'created_at', 'updated_at'] },
]

const seccionesDetalle = computed(() => {
  const row = activacionSeleccionada.value
  if (!row) return []
  const usedKeys = new Set(seccionesDetalleConfig.flatMap((section) => section.keys))
  const siempreVisibles = new Set(['creditos', 'remesas'])
  const sections = seccionesDetalleConfig.map((section) => ({
    title: section.title,
    fields: section.keys
      .filter((key) => key === 'ciudad_activacion' || tieneValor(row[key]) || siempreVisibles.has(key))
      .map((key) => ({
        key,
        label: etiquetaCampo(key),
        value: key === 'ciudad_activacion'
          ? etiquetaCiudadActivacion(row)
          : (siempreVisibles.has(key) ? row[key] === true : row[key]),
        signedUrl: getFotoSignedUrl(row, key),
        image: key.toLowerCase().includes('foto'),
      })),
  }))
  const ocultos = tieneValor(row.usuario_email) ? new Set(['usuario_id']) : new Set()
  const extras = Object.entries(row)
    .filter(([key, value]) => !usedKeys.has(key) && !ocultos.has(key) && tieneValor(value))
    .map(([key, value]) => ({ key, label: etiquetaCampo(key), value, signedUrl: getFotoSignedUrl(row, key), image: key.toLowerCase().includes('foto') }))
  sections.at(-1).fields.push(...extras)
  return sections.filter((section) => section.fields.length)
})

function getClienteComercio(activacion) {
  return activacion.nombre_comercio ?? activacion.comercio ?? activacion.cliente ??
    ([activacion.nombres_cliente, activacion.apellidos_cliente].filter(Boolean).join(' ') || '-')
}

function getFotoSignedUrl(row, key) {
  if (key === 'foto_url') return row.foto_url_signed ?? ''
  if (key === 'foto_cash_in' || key === 'foto_cashin') return row.foto_cash_in_signed ?? ''
  return ''
}

function getResultado(activacion) {
  if (activacion.hubo_error === true) return 'Con error'
  return activacion.resultado ?? activacion.estado ?? 'Registrada'
}

const cargandoDetalle = ref(false)
let solicitudDetalle = 0
async function abrirDetalle(activacion) {
  activacionSeleccionada.value = activacion
  if (!activacion?.id) return
  const solicitud = ++solicitudDetalle
  cargandoDetalle.value = true
  try {
    const completa = await fetchActivacionDetalle(activacion.id)
    if (solicitud === solicitudDetalle && completa) activacionSeleccionada.value = completa
  } catch (error) {
    if (solicitud !== solicitudDetalle) return
    logClientError('activaciones.detalle', error)
    notifyError(getErrorMessage(error))
  } finally {
    if (solicitud === solicitudDetalle) cargandoDetalle.value = false
  }
}
function limpiarFotosSeleccionadas() {
  fotoPrincipalArchivo.value = null
  fotoCashInArchivo.value = null
  if (inputFotoPrincipal.value) inputFotoPrincipal.value.value = ''
  if (inputFotoCashIn.value) inputFotoCashIn.value.value = ''
}
function cerrarDetalle() {
  if (guardandoEdicion.value || reemplazandoFoto.value) return
  solicitudDetalle += 1
  cargandoDetalle.value = false
  activacionSeleccionada.value = null
  editandoActivacion.value = false
  limpiarFotosSeleccionadas()
}

function tieneCampo(row, key) {
  return Object.prototype.hasOwnProperty.call(row ?? {}, key)
}

const nombreComercialKey = computed(() => {
  const row = activacionSeleccionada.value
  const columns = ['nombre_comercio', 'comercio', 'cliente']
  return columns.find((key) => tieneValor(row?.[key])) ??
    columns.find((key) => tieneCampo(row, key)) ?? null
})
const esCategoriaPersona = computed(() => ['transeunte', 'cliente_antiguo'].includes(formularioEdicion.value.tipo_grupo))
const nombresVisible = computed(() => esCategoriaPersona.value || tieneValor(activacionSeleccionada.value?.nombres_cliente))
const nombreComercialVisible = computed(() => Boolean(nombreComercialKey.value) &&
  (!esCategoriaPersona.value || tieneValor(activacionSeleccionada.value?.[nombreComercialKey.value])))
const plazaEditableKey = computed(() => tieneCampo(activacionSeleccionada.value, 'ciudad_activacion') ? 'ciudad_activacion' : 'plaza')
const resultadoEditableKey = computed(() => ['resultado', 'estado'].find((key) => tieneCampo(activacionSeleccionada.value, key)) ?? null)
const tiposActivacionDisponibles = computed(() => ACTIVATION_TYPES_BY_CATEGORY[formularioEdicion.value.tipo_grupo] ?? [])
const esActivacionComercio = computed(() => isGeneralCommerce(
  formularioEdicion.value.tipo_grupo,
  formularioEdicion.value.tipo_activacion,
))
const esTiendaBarrio = computed(() => formularioEdicion.value.tipo_grupo === 'tienda_barrio')
const mostrarCreditos = computed(() => isCreditosEligible(formularioEdicion.value) || formularioEdicion.value.creditos === true)
const mostrarRemesas = computed(() => isRemesasEligible(formularioEdicion.value) || formularioEdicion.value.remesas === true)
const motivoEdicionFaltante = computed(() => !motivoEdicion.value.trim())

function iniciarEdicion() {
  const row = activacionSeleccionada.value
  if (!row) return
  formularioEdicion.value = {
    nombre_comercial: nombreComercialKey.value ? row[nombreComercialKey.value] ?? '' : '',
    nombres_cliente: row.nombres_cliente ?? '',
    apellidos_cliente: row.apellidos_cliente ?? '',
    ci_cliente: row.ci_cliente ?? '',
    telefono_cliente: row.telefono_cliente ?? '',
    email_cliente: row.email_cliente ?? '',
    plaza: row[plazaEditableKey.value] ?? '',
    tipo_grupo: inferActivationCategory(row),
    tipo_activacion: row.tipo_activacion ?? '',
    resultado: resultadoEditableKey.value ? row[resultadoEditableKey.value] ?? '' : '',
    tamano_tienda: row.tamano_tienda ?? row.tipo_tienda ?? '',
    tipo_tienda: row.tipo_tienda ?? null,
    tipo_comercio: row.tipo_comercio ?? null,
    rubro_comercio: row.rubro_comercio ?? '',
    rubro_comercio_otro: row.rubro_comercio_otro ?? '',
    comercio_fuera_mercado: typeof row.comercio_fuera_mercado === 'boolean' ? row.comercio_fuera_mercado : null,
    observaciones: row.observaciones ?? '',
    tipo_error: row.tipo_error ?? '',
    descripcion_error: row.descripcion_error ?? '',
    creditos: row.creditos === true,
    remesas: row.remesas === true,
    descargo_app: row.descargo_app === true,
    registro: row.registro === true,
    cash_in: row.cash_in === true,
    cash_out: row.cash_out === true,
    p2p: row.p2p === true,
    qr_fisico: row.qr_fisico === true,
    respaldo: row.respaldo === true,
    hubo_error: row.hubo_error === true,
    es_plaza_temporal: row.es_plaza_temporal === true,
    plaza_temporal: row.plaza_temporal ?? '',
  }
  formularioEdicionInicial.value = { ...formularioEdicion.value }
  motivoEdicion.value = ''
  limpiarFotosSeleccionadas()
  editandoActivacion.value = true
}

function confirmarCambioClasificacion(mensaje) {
  return typeof window === 'undefined' || window.confirm(mensaje)
}

function cambiarCategoria(event) {
  const categoria = event.target.value
  const actual = formularioEdicion.value.tipo_grupo
  if (categoria === actual) return
  if (!confirmarCambioClasificacion('Cambiar la categoría limpiará únicamente los campos incompatibles. ¿Continuar?')) {
    event.target.value = actual
    return
  }
  formularioEdicion.value = normalizeActivationClassification({
    ...formularioEdicion.value,
    tipo_grupo: categoria,
    tipo_activacion: '',
  })
}

function cambiarTipoActivacion(event) {
  const tipo = event.target.value
  const actual = formularioEdicion.value.tipo_activacion
  if (tipo === actual) return
  const limpiaComercio = esActivacionComercio.value &&
    !isGeneralCommerce(formularioEdicion.value.tipo_grupo, tipo)
  if (limpiaComercio && !confirmarCambioClasificacion('Este tipo no utiliza datos de rubro comercial. ¿Cambiar y limpiar esos campos?')) {
    event.target.value = actual
    return
  }
  formularioEdicion.value = normalizeActivationClassification({
    ...formularioEdicion.value,
    tipo_activacion: tipo,
  })
}

function cancelarEdicion() {
  if (guardandoEdicion.value || reemplazandoFoto.value) return
  editandoActivacion.value = false
  formularioEdicion.value = {}
  formularioEdicionInicial.value = {}
  motivoEdicion.value = ''
  limpiarFotosSeleccionadas()
}

function seleccionarFoto(tipo, event) {
  const file = event.target.files?.[0] ?? null
  const target = tipo === 'principal' ? fotoPrincipalArchivo : fotoCashInArchivo
  if (!file) { target.value = null; return }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    event.target.value = ''
    target.value = null
    notifyWarning('La foto debe ser JPEG, PNG o WebP.')
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    event.target.value = ''
    target.value = null
    notifyWarning('La foto no puede superar 10 MB.')
    return
  }
  target.value = file
}

async function reemplazarFoto(tipo) {
  if (!canEditActivaciones.value || !isAdmin.value) {
    notifyWarning('Sesion administrativa requerida.')
    return
  }
  const activationId = normalizeText(activacionSeleccionada.value?.id)
  const file = tipo === 'principal' ? fotoPrincipalArchivo.value : fotoCashInArchivo.value
  if (!activationId || !file) {
    notifyWarning(!activationId ? 'La activacion no tiene ID.' : 'Selecciona una foto valida.')
    return
  }

  reemplazandoFoto.value = tipo
  try {
    const response = await fetch(`${apiBaseUrl}/admin/activaciones/${encodeURIComponent(activationId)}/fotos/${tipo}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${session.value.access_token}`,
        'Content-Type': file.type,
      },
      body: file,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(payload?.error || `Error HTTP ${response.status}`)
    activacionSeleccionada.value = payload.activation
    emit('activacion-actualizada', { activation: payload.activation })
    limpiarFotosSeleccionadas()
    if (payload.warning) notifyWarning(payload.warning)
    else notifySuccess(tipo === 'principal' ? 'Evidencia principal reemplazada.' : 'Evidencia Cash-In reemplazada.')
  } catch (error) {
    notifyError(getErrorMessage(error))
  } finally {
    reemplazandoFoto.value = ''
  }
}

function validarEdicion() {
  const form = formularioEdicion.value
  const classificationError = validateActivationEdit(form, motivoEdicion.value, activacionSeleccionada.value)
  if (classificationError) return classificationError
  const textLengthError = validateActivationTextLengths(form)
  if (textLengthError) return textLengthError
  if (form.email_cliente && !isValidEmail(normalizeEmail(form.email_cliente))) return 'Ingresa un correo valido.'
  if (form.telefono_cliente && !/^\+?[0-9\s()\-]{6,20}$/.test(form.telefono_cliente.trim())) return 'Ingresa un telefono valido.'
  if (form.es_plaza_temporal && !form.plaza_temporal.trim()) return 'La plaza temporal es obligatoria.'
  if (form.hubo_error && !form.tipo_error) return 'Selecciona el tipo de error.'
  if (form.hubo_error && form.tipo_error === 'Otro' && !form.descripcion_error.trim()) return 'Describe el error.'
  return null
}

function construirCambiosEdicion() {
  const form = normalizeActivationClassification(formularioEdicion.value, activacionSeleccionada.value)
  const initial = normalizeActivationClassification(formularioEdicionInicial.value, activacionSeleccionada.value)
  const sizeChanged = form.tamano_tienda !== initial.tamano_tienda
  if (form.tipo_grupo === 'tienda_barrio' && sizeChanged) form.tipo_tienda = form.tamano_tienda
  const changes = {}
  const setIfChanged = (key, value) => {
    if (value !== initial[key]) changes[key] = value
  }
  if (nombreComercialKey.value) setIfChanged(nombreComercialKey.value, form.nombre_comercial)
  setIfChanged('nombres_cliente', form.nombres_cliente)
  setIfChanged('apellidos_cliente', form.apellidos_cliente)
  setIfChanged('ci_cliente', form.ci_cliente)
  setIfChanged('telefono_cliente', form.telefono_cliente)
  setIfChanged('email_cliente', form.email_cliente)
  setIfChanged(plazaEditableKey.value, form.plaza)
  setIfChanged('observaciones', form.observaciones)
  setIfChanged('tipo_error', form.tipo_error)
  setIfChanged('descripcion_error', form.descripcion_error)
  const plazaTemporal = form.es_plaza_temporal ? form.plaza_temporal : null
  const initialPlazaTemporal = initial.es_plaza_temporal ? initial.plaza_temporal : null
  if (form.es_plaza_temporal !== initial.es_plaza_temporal || plazaTemporal !== initialPlazaTemporal) {
    changes.es_plaza_temporal = form.es_plaza_temporal
    changes.plaza_temporal = plazaTemporal
  }
  const classificationFields = [
    'tipo_activacion', 'tamano_tienda', 'tipo_tienda', 'tipo_comercio',
    'rubro_comercio', 'rubro_comercio_otro', 'comercio_fuera_mercado',
  ]
  if (form.tipo_grupo !== initial.tipo_grupo || classificationFields.some((key) => form[key] !== initial[key])) {
    classificationFields.forEach((key) => { changes[key] = form[key] })
    if (!sizeChanged) {
      delete changes.tipo_tienda
      delete changes.tamano_tienda
    }
  }
  for (const key of ['descargo_app', 'registro', 'cash_in', 'cash_out', 'p2p', 'qr_fisico', 'respaldo', 'creditos', 'remesas', 'hubo_error']) {
    if (form[key] !== initial[key]) changes[key] = form[key]
  }
  if (resultadoEditableKey.value) setIfChanged(resultadoEditableKey.value, form.resultado)
  return changes
}

async function guardarEdicion() {
  const validationError = validarEdicion()
  if (validationError) { notifyWarning(validationError); return }
  const activationId = normalizeText(activacionSeleccionada.value?.id)
  if (!activationId || !canEditActivaciones.value) {
    notifyWarning(!activationId ? 'La activacion no tiene ID.' : 'Conecta la API admin para editar activaciones.')
    return
  }
  guardandoEdicion.value = true
  try {
    const result = await requestAdmin(`/admin/activaciones/${encodeURIComponent(activationId)}`, {
      method: 'PATCH',
      body: {
        changes: construirCambiosEdicion(),
        motivoEdicion: motivoEdicion.value.trim(),
        categoriaActivacion: formularioEdicion.value.tipo_grupo,
      },
    })
    activacionSeleccionada.value = result.activation
    emit('activacion-actualizada', { activation: result.activation })
    editandoActivacion.value = false
    formularioEdicion.value = {}
    formularioEdicionInicial.value = {}
    motivoEdicion.value = ''
    notifySuccess('Activacion actualizada correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { guardandoEdicion.value = false }
}

async function requestAdmin(path, options = {}) {
  return adminApiRequest({
    baseUrl: apiBaseUrl,
    path,
    token: session.value?.access_token,
    ...options,
  })
}

async function eliminarActivacion(activacion) {
  if (!canEditActivaciones.value) {
    notifyWarning('Sesion administrativa requerida.')
    return
  }

  const activacionId = normalizeText(activacion?.id)
  if (!activacionId) {
    notifyWarning('Esta activacion no tiene ID y no se puede eliminar de forma segura.')
    return
  }

  const password = await requestPasswordConfirmation({
    title: 'Eliminar activacion',
    message: 'Ingresa tu contraseña actual para eliminar el registro y sus fotos de forma permanente.',
    confirmLabel: 'Eliminar definitivamente',
  })
  if (!password) return

  deletingActivationId.value = activacionId

  try {
    const result = await requestAdmin(`/admin/activaciones/${encodeURIComponent(activacionId)}`, {
      method: 'DELETE',
      body: { password },
    })

    emit('activacion-eliminada', { id: activacionId })
    activacionSeleccionada.value = null

    if (result?.photoDelete?.ok === false) {
      notifyWarning(
        'Activacion eliminada, pero no fue posible borrar la foto en Storage. Revisa limpieza manual.'
      )
    } else if (result?.photoDelete?.attempted) {
      notifySuccess('Activacion y foto eliminadas correctamente.')
    } else {
      notifySuccess('Activacion eliminada correctamente.')
    }
  } catch (error) {
    notifyError(getErrorMessage(error))
  } finally {
    deletingActivationId.value = null
  }
}

function descargarArchivo({ filename, content, mimeType }) {
  const blob = new Blob([content], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

function getDatosParaExportar() {
  return fetchActivacionesExportacion(filtrosActuales())
}

const columnasExportacion = [
  ['#', (_row, index) => index + 1],
  ['Creado', (row) => formatCreatedAtBolivia(row.created_at, { emptyValue: '' })],
  ['Fecha', (row) => row.fecha_activacion],
  ['Impulsador', (row) => row.impulsador],
  ['Ciudad', (row) => getCiudadActivacion(row)],
  ['Distrito', (row) => row.zona_activacion],
  ['Equipo', (row) => row.equipo_nombre_registro ?? row.equipo_numero_registro],
  ['Facturador', (row) => row.facturador_nombre_registro],
  ['Lider Vigente', (row) => row.lider_nombre_registro],
  ['Plaza Base', (row) => row.plaza_base_registro],
  ['Plaza ID', (row) => row.plaza_id_registro],
  ['Plaza Efectiva', (row) => row.plaza_efectiva_registro],
  ['Nombres Cliente', (row) => row.nombres_cliente],
  ['Apellidos Cliente', (row) => row.apellidos_cliente],
  ['CI Cliente', (row) => row.ci_cliente],
  ['Telefono Cliente', (row) => row.telefono_cliente],
  ['Email Cliente', (row) => row.email_cliente],
  ['Descargo App', (row) => (row.descargo_app ? 'Si' : 'No')],
  ['Registro', (row) => (row.registro ? 'Si' : 'No')],
  ['Cash In', (row) => (row.cash_in ? 'Si' : 'No')],
  ['Cash Out', (row) => (row.cash_out ? 'Si' : 'No')],
  ['P2P', (row) => (row.p2p ? 'Si' : 'No')],
  ['QR Fisico', (row) => (row.qr_fisico ? 'Si' : 'No')],
  ['Respaldo', (row) => (row.respaldo ? 'Si' : 'No')],
  ['Hubo Error', (row) => (row.hubo_error ? 'Si' : 'No')],
  ['Descripcion Error', (row) => row.descripcion_error],
  ['Tipo Activacion', (row) => row.tipo_activacion],
  ['Tipo Comercio', (row) => row.tipo_comercio],
  ['Tamano Tienda', (row) => row.tamano_tienda],
  ['Tipo Tienda', (row) => row.tipo_tienda],
  ['Rubro Comercio', (row) => row.rubro_comercio],
  ['Otro Rubro', (row) => row.rubro_comercio_otro],
  ['Comercio Fuera de Mercado', (row) => row.comercio_fuera_mercado == null ? '' : row.comercio_fuera_mercado ? 'Si' : 'No'],
  ['Tipo Error', (row) => row.tipo_error],
  ['Observaciones', (row) => row.observaciones],
  ['Es Plaza Temporal', (row) => row.es_plaza_temporal == null ? '' : row.es_plaza_temporal ? 'Si' : 'No'],
  ['Plaza Temporal', (row) => row.plaza_temporal],
  ['Foto URL', (row) => absoluteEvidenceUrl(row.foto_url_evidencia)],
  ['Foto Cash-In', (row) => absoluteEvidenceUrl(row.foto_cash_in_evidencia)],
  ['Latitud', (row) => row.latitud],
  ['Longitud', (row) => row.longitud],
  ['Usuario ID', (row) => row.usuario_id],
  ['Creditos', (row) => (row.creditos ? 'Si' : 'No')],
  ['Remesas', (row) => (row.remesas ? 'Si' : 'No')],
]

const checklistExcel = [
  ['Checklist - Descargó App', (row) => valorBooleano(row.descargo_app)],
  ['Checklist - Registro', (row) => valorBooleano(row.registro)],
  ['Checklist - Cash-In', (row) => valorBooleano(row.cash_in)],
  ['Checklist - Cash-Out', (row) => valorBooleano(row.cash_out)],
  ['Checklist - P2P', (row) => valorBooleano(row.p2p)],
  ['Checklist - QR Físico', (row) => valorBooleano(row.qr_fisico)],
  ['Checklist - Respaldo', (row) => valorBooleano(row.respaldo)],
]

const columnasExcelPersonalizado = [
  ['Fecha de la Activación', (row) => getFechaExcelDate(row)],
  ['Ciudad', (row) => etiquetaCiudadActivacion(row)],
  ['Zona de Activación', (row) => row.zona_activacion],
  ['Tipo de Activación', (row) => row.tipo_activacion],
  ['Tienda Barrio - Tamaño', (row) => tieneValor(row.tamano_tienda) ? row.tamano_tienda : esTiendaBarrioRow(row) ? primerValor(row, ['tipo_tienda']) : ''],
  ['Tienda Barrio - Tipo de Activación', (row) => tieneValor(row.tamano_tienda) ? 'Tienda de Barrio' : esTiendaBarrioRow(row) ? primerValor(row, ['tipo_activacion', 'tipo_comercio']) : ''],
  ['Comercio - Tipo de Activación', (row) => esComercioRow(row) ? row.tipo_comercio : ''],
  ['Comercio - Rubro', (row) => {
    const rubro = [row.rubro_comercio, row.rubro_comercio_otro].filter(Boolean).join(' - ')
    if (esComercioRow(row)) return rubro
    return rubro || ''
  }],
  ['Comercio - Fuera del mercado', (row) => {
    if (esComercioRow(row)) return valorBooleano(row.comercio_fuera_mercado)
    return row.comercio_fuera_mercado == null ? '' : valorBooleano(row.comercio_fuera_mercado)
  }],
  ['Transeúnte - Tipo de Activación', (row) => esTranseunteRow(row) ? row.tipo_activacion : ''],
  ['Nombre del Activador', (row) => row.impulsador],
  ['Nombre', (row) => row.nombres_cliente],
  ['Apellidos', (row) => row.apellidos_cliente],
  ['Cédula', (row) => row.ci_cliente],
  ['Teléfono', (row) => row.telefono_cliente],
  ['Correo', (row) => row.email_cliente],
  ['Foto de la Activación', (row) => evidenciaHyperlinkCell(row.foto_url_evidencia)],
  ['Foto Cash-In', (row) => evidenciaHyperlinkCell(row.foto_cash_in_evidencia)],
  ...checklistExcel,
  ['Hubo Error', (row) => valorBooleano(row.hubo_error)],
  ['Tipo de Error', (row) => row.tipo_error],
  ['Descripción del Error', (row) => row.descripcion_error],
  ['Créditos', (row) => (row.creditos ? 'Si' : 'No')],
  ['Remesas', (row) => (row.remesas ? 'Si' : 'No')],
]

async function exportarACsv() {
  exportandoExcel.value = true
  let datos
  try {
    datos = await getDatosParaExportar()
  } catch (error) {
    logClientError('activaciones.export.csv', error)
    notifyError(getErrorMessage(error))
    return
  } finally {
    exportandoExcel.value = false
  }

  if (!datos.length) {
    notifyInfo('No hay datos para exportar con los filtros actuales.')
    return
  }

  const csvLines = []
  csvLines.push(columnasExportacion.map(([header]) => csvEscape(header)).join(';'))

  for (const [index, row] of datos.entries()) {
    const values = columnasExportacion.map(([, getValue]) =>
      csvEscape(getValue(row, index))
    )
    csvLines.push(values.join(';'))
  }

  descargarArchivo({
    filename: 'activaciones.csv',
    content: `\uFEFF${csvLines.join('\r\n')}`,
    mimeType: 'text/csv;charset=utf-8;',
  })

  notifySuccess('CSV exportado correctamente.')
}

async function exportarAExcelConImagenes() {
  exportandoExcel.value = true
  try {
    const params = new URLSearchParams()
    if (filtroPlaza.value) params.set('plaza', filtroPlaza.value)
    if (filtroDistrito.value) params.set('distrito', filtroDistrito.value)
    if (filtroImpulsador.value) params.set('impulsador', filtroImpulsador.value)
    if (filtroFechaDesde.value) params.set('fechaDesde', filtroFechaDesde.value)
    if (filtroFechaHasta.value) params.set('fechaHasta', filtroFechaHasta.value)
    params.set('exportVersion', 'links-v2')

    const token = session.value?.access_token
    if (!token) throw new Error('Sesion requerida para generar el Excel.')
    const response = await fetch(`${apiBaseUrl}/portal/activations/export-excel?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.error || `Error HTTP ${response.status}`)
    }
    if (response.headers.get('X-Export-Version') !== 'links-v2') {
      throw new Error('La API respondio con una version antigua de la exportacion. Vuelve a desplegar el backend.')
    }

    const rowCount = Number(response.headers.get('X-Export-Row-Count')) || 0
    const imageMode = response.headers.get('X-Export-Images')
    descargarArchivo({
      filename: 'activaciones.xlsx',
      content: await response.arrayBuffer(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    notifySuccess(
      imageMode === 'links'
        ? `Excel exportado con ${rowCount} registros y enlaces a imagenes.`
        : `Excel exportado con ${rowCount} registros e imagenes.`
    )
  } catch (error) {
    logClientError('activaciones.export.excel-servidor', error)
    notifyError(getErrorMessage(error))
  } finally {
    exportandoExcel.value = false
  }
}

async function descargarExcelPersonalizado() {
  exportandoExcel.value = true
  try {
    const datos = await getDatosParaExportar()
    if (!datos.length) {
      notifyInfo('No hay datos para exportar con los filtros actuales.')
      return
    }

    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Impulsa 360'
    workbook.created = new Date()
    const worksheet = workbook.addWorksheet('Activaciones')

    worksheet.columns = columnasExcelPersonalizado.map(([header]) => ({
      header,
      key: header,
      width: Math.max(14, Math.min(36, String(header).length + 4)),
    }))
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(columnasExcelPersonalizado.length).letter}1` }
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1769FF' } }
    worksheet.getRow(1).alignment = { vertical: 'middle', wrapText: true }

    datos.forEach((row) => {
      worksheet.addRow(neutralizeExportRow(Object.fromEntries(columnasExcelPersonalizado.map(([header, getValue]) => [header, getValue(row) ?? '']))))
    })
    worksheet.getColumn('Fecha de la Activación').eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber > 1 && cell.value instanceof Date) {
        cell.numFmt = 'dd/mm/yyyy hh:mm'
      }
    })
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          left: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          bottom: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          right: { style: 'thin', color: { argb: 'FFDCE8F4' } },
        }
        if (cell.value && typeof cell.value === 'object' && cell.value.hyperlink) {
          cell.font = { color: { argb: 'FF0563C1' }, underline: true }
        }
      })
    })

    descargarArchivo({
      filename: 'activaciones-personalizado.xlsx',
      content: await workbook.xlsx.writeBuffer(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    notifySuccess(`Excel descargado con ${datos.length} registros filtrados.`)
  } catch (error) {
    logClientError('activaciones.export.excel-personalizado', error)
    notifyError(getErrorMessage(error))
  } finally {
    exportandoExcel.value = false
  }
}

</script>

<template>
  <div class="activaciones-container section-block">
    <div class="section-head">
      <h2 class="section-title">Bitacora Completa</h2>
      <p class="section-caption">
        Filtra la base por rango de fechas, impulsador, plaza o distrito y exporta los resultados.
      </p>
    </div>
    <div class="filtros filtros-grid filtros-activaciones">
      <label>
        <span class="field-label">Fecha desde</span>
        <input type="date" v-model="filtroFechaDesde" class="input-texto" />
      </label>

      <label>
        <span class="field-label">Fecha hasta</span>
        <input type="date" v-model="filtroFechaHasta" class="input-texto" />
      </label>

      <label>
        <span class="field-label">Impulsador</span>
        <input
          type="text"
          v-model="filtroImpulsador"
          placeholder="Buscar impulsador"
          class="input-texto"
        />
      </label>

      <label>
        <span class="field-label">Ciudad</span>
        <input
          type="text"
          v-model="filtroPlaza"
          placeholder="Buscar ciudad"
          class="input-texto"
        />
      </label>

      <label>
        <span class="field-label">Distrito</span>
        <input
          type="text"
          v-model="filtroDistrito"
          placeholder="Buscar distrito"
          class="input-texto"
        />
      </label>
    </div>

    <div class="toolbar-line">
      <div class="toolbar-actions">
        <button type="button" @click="exportarACsv" class="boton-exportar" :disabled="exportandoExcel || deletingActivationId">Exportar CSV</button>
        <button
          type="button"
          @click="exportarAExcelConImagenes"
          class="boton-exportar boton-exportar-excel"
          :disabled="exportandoExcel || deletingActivationId"
        >
          {{ exportandoExcel ? 'Generando Excel en servidor...' : 'Exportar Excel + Imagenes' }}
        </button>
        <button type="button" @click="descargarExcelPersonalizado" class="boton-exportar boton-exportar-excel" :disabled="exportandoExcel || deletingActivationId || !total">Descargar Excel</button>
      </div>
      <span class="meta-pill">{{ loading ? 'Cargando...' : `${total} registros` }}</span>
    </div>

    <p v-if="loading && filas.length === 0" class="panel-empty">Cargando activaciones...</p>
    <p v-else-if="filas.length === 0" class="panel-empty">
      No hay registros para los filtros seleccionados.
    </p>

    <div v-else class="table-wrap activaciones-table-wrap activaciones-resumen-wrap" :class="{ 'tabla-cargando': loading }">
      <table class="tabla-activaciones">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Hora</th>
            <th>Activador o impulsador</th>
            <th>Cliente o comercio</th>
            <th>Tipo Activacion</th>
            <th>Ciudad</th>
            <th>Estado o resultado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(activacion, index) in filas" :key="getRowKey(activacion, index)" class="activacion-row" tabindex="0" @click="abrirDetalle(activacion)" @keydown.enter="abrirDetalle(activacion)">
            <td>{{ activacion.fecha_activacion || formatCreatedAtBolivia(activacion.created_at) }}</td>
            <td>{{ formatHoraRegistro(activacion.created_at) }}</td>
            <td>{{ activacion.impulsador || '-' }}</td>
            <td>{{ getClienteComercio(activacion) }}</td>
            <td>{{ activacion.tipo_activacion || '-' }}</td>
            <td>{{ getCiudadActivacion(activacion) }}</td>
            <td><span class="resultado-etiqueta" :class="{ 'resultado-error': activacion.hubo_error === true }">{{ getResultado(activacion) }}</span></td>
            <td>
              <div class="acciones">
                <button class="boton boton-editar" @click.stop="abrirDetalle(activacion)">Ver detalle</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="total > pageSize" class="activaciones-paginacion">
      <button type="button" class="boton boton-pequeno" :disabled="loading || page <= 1" @click="emit('cambiar-pagina', page - 1)">Anterior</button>
      <span>{{ rangoVisible }} de {{ total }}</span>
      <button type="button" class="boton boton-pequeno" :disabled="loading || page >= totalPaginas" @click="emit('cambiar-pagina', page + 1)">Siguiente</button>
    </div>

    <teleport to="body">
      <div v-if="activacionSeleccionada" class="detalle-overlay" @click.self="cerrarDetalle">
        <aside class="detalle-activacion" role="dialog" aria-modal="true" aria-label="Detalle de activacion">
          <header class="detalle-header">
            <div><p class="view-kicker">Registro de activacion</p><h3 class="detalle-title">{{ getClienteComercio(activacionSeleccionada) }}</h3></div>
            <button v-if="canEditActivaciones && !editandoActivacion" type="button" class="boton boton-editar" :disabled="!activacionSeleccionada.id || cargandoDetalle" @click="iniciarEdicion">Editar</button>
            <button type="button" class="detalle-close" aria-label="Cerrar detalle" @click="cerrarDetalle">×</button>
          </header>
          <p v-if="cargandoDetalle" class="panel-empty">Cargando detalle completo...</p>
          <form v-if="editandoActivacion" class="detalle-body" @submit.prevent="guardarEdicion">
            <fieldset class="edicion-activacion" :disabled="guardandoEdicion || Boolean(reemplazandoFoto)">
              <label v-if="nombreComercialVisible"><span class="field-label">Nombre del cliente o comercio</span><input v-model="formularioEdicion.nombre_comercial" class="input-texto"></label>
              <label v-if="nombresVisible"><span class="field-label">Nombres</span><input v-model="formularioEdicion.nombres_cliente" class="input-texto"></label>
              <label v-if="nombresVisible"><span class="field-label">Apellidos</span><input v-model="formularioEdicion.apellidos_cliente" class="input-texto"></label>
              <label v-if="nombresVisible"><span class="field-label">Cédula de identidad</span><input v-model="formularioEdicion.ci_cliente" class="input-texto"></label>
              <label><span class="field-label">Telefono</span><input v-model="formularioEdicion.telefono_cliente" class="input-texto" inputmode="tel"></label>
              <label><span class="field-label">Correo</span><input v-model="formularioEdicion.email_cliente" type="email" class="input-texto"></label>
              <label><span class="field-label">Ciudad de activación</span>
                <template v-if="opcionesOrg.available">
                  <select v-model="formularioEdicion.plaza" class="input-texto"><option value="">Selecciona ciudad</option><option v-for="p in opcionesOrg.plazas" :key="p.id" :value="p.nombre">{{ p.nombre }}</option></select>
                </template>
                <template v-else>
                  <input v-model="formularioEdicion.plaza" class="input-texto">
                </template>
              </label>
              <label><span class="field-label">Categoría</span><select :value="formularioEdicion.tipo_grupo" class="input-texto" @change="cambiarCategoria"><option value="">Selecciona categoría</option><option v-for="categoria in ACTIVATION_CATEGORIES" :key="categoria.key" :value="categoria.key">{{ categoria.label }}</option></select></label>
              <label><span class="field-label">Tipo de activacion</span><select :value="formularioEdicion.tipo_activacion" class="input-texto" :disabled="!formularioEdicion.tipo_grupo" @change="cambiarTipoActivacion"><option value="">Selecciona tipo</option><option v-if="formularioEdicion.tipo_activacion && !tiposActivacionDisponibles.some((item) => item.key === formularioEdicion.tipo_activacion)" :value="formularioEdicion.tipo_activacion">Histórico: {{ formularioEdicion.tipo_activacion }}</option><option v-for="tipo in tiposActivacionDisponibles" :key="tipo.key" :value="tipo.key">{{ tipo.label }}</option></select></label>
              <label v-if="esTiendaBarrio"><span class="field-label">Tamaño de tienda</span><select v-model="formularioEdicion.tamano_tienda" class="input-texto"><option value="">Selecciona tamaño</option><option v-if="formularioEdicion.tamano_tienda && !STORE_SIZES.includes(formularioEdicion.tamano_tienda)" :value="formularioEdicion.tamano_tienda">Histórico: {{ formularioEdicion.tamano_tienda }}</option><option v-for="tamano in STORE_SIZES" :key="tamano" :value="tamano">{{ tamano }}</option></select></label>
              <label v-if="resultadoEditableKey"><span class="field-label">Resultado o estado</span><input v-model="formularioEdicion.resultado" class="input-texto"></label>
              <template v-if="esActivacionComercio">
                <label><span class="field-label">Rubro del comercio</span><select v-model="formularioEdicion.rubro_comercio" class="input-texto"><option value="">Selecciona rubro</option><option v-if="formularioEdicion.rubro_comercio && !COMMERCE_CATEGORIES.includes(formularioEdicion.rubro_comercio)" :value="formularioEdicion.rubro_comercio">Histórico: {{ formularioEdicion.rubro_comercio }}</option><option v-for="rubro in COMMERCE_CATEGORIES" :key="rubro" :value="rubro">{{ rubro }}</option></select></label>
                <label v-if="formularioEdicion.rubro_comercio === 'Otro'"><span class="field-label">Otro rubro</span><input v-model="formularioEdicion.rubro_comercio_otro" class="input-texto"></label>
                <label><span class="field-label">Comercio fuera de mercado</span><select v-model="formularioEdicion.comercio_fuera_mercado" class="input-texto"><option :value="null">Selecciona</option><option :value="false">No</option><option :value="true">Si</option></select></label>
              </template>
              <label v-if="mostrarCreditos"><span class="field-label">Créditos</span><select v-model="formularioEdicion.creditos" class="input-texto"><option :value="false">No</option><option :value="true">Sí</option></select></label>
              <label v-if="mostrarRemesas"><span class="field-label">Remesas</span><select v-model="formularioEdicion.remesas" class="input-texto"><option :value="false">No</option><option :value="true">Sí</option></select></label>
              <label v-for="campo in [{ key: 'descargo_app', label: 'Descargó la app' }, { key: 'registro', label: 'Registro' }, { key: 'cash_in', label: 'Cash-In' }, { key: 'cash_out', label: 'Cash-Out' }, { key: 'p2p', label: 'P2P' }, { key: 'qr_fisico', label: 'QR físico' }, { key: 'respaldo', label: 'Respaldo' }]" :key="campo.key"><span class="field-label">{{ campo.label }}</span><select v-model="formularioEdicion[campo.key]" class="input-texto"><option :value="false">No</option><option :value="true">Sí</option></select></label>
              <label class="edicion-field-wide"><span class="field-label">Observaciones</span><textarea v-model="formularioEdicion.observaciones" class="input-texto" rows="3"></textarea></label>
              <label><span class="field-label">Hubo error</span><select v-model="formularioEdicion.hubo_error" class="input-texto"><option :value="false">No</option><option :value="true">Sí</option></select></label>
              <label v-if="formularioEdicion.hubo_error"><span class="field-label">Tipo de error</span><select v-model="formularioEdicion.tipo_error" class="input-texto"><option value="">Selecciona tipo</option><option v-if="formularioEdicion.tipo_error && !ACTIVATION_ERROR_TYPES.includes(formularioEdicion.tipo_error)" :value="formularioEdicion.tipo_error">Histórico: {{ formularioEdicion.tipo_error }}</option><option v-for="tipoError in ACTIVATION_ERROR_TYPES" :key="tipoError" :value="tipoError">{{ tipoError }}</option></select></label>
              <label v-if="formularioEdicion.hubo_error && formularioEdicion.tipo_error === 'Otro'" class="edicion-field-wide"><span class="field-label">Descripcion del error</span><textarea v-model="formularioEdicion.descripcion_error" class="input-texto" rows="3"></textarea></label>
              <label v-if="canAdminister"><span class="field-label">Evidencia principal</span><input ref="inputFotoPrincipal" type="file" accept="image/jpeg,image/png,image/webp" class="input-texto" @change="seleccionarFoto('principal', $event)"><button type="button" class="boton boton-editar" :disabled="!fotoPrincipalArchivo" @click="reemplazarFoto('principal')">{{ reemplazandoFoto === 'principal' ? 'Reemplazando...' : 'Reemplazar evidencia' }}</button></label>
              <label v-if="canAdminister"><span class="field-label">Evidencia Cash-In</span><input ref="inputFotoCashIn" type="file" accept="image/jpeg,image/png,image/webp" class="input-texto" @change="seleccionarFoto('cash-in', $event)"><button type="button" class="boton boton-editar" :disabled="!fotoCashInArchivo" @click="reemplazarFoto('cash-in')">{{ reemplazandoFoto === 'cash-in' ? 'Reemplazando...' : 'Reemplazar Cash-In' }}</button></label>
              <label><span class="field-label">Es plaza temporal</span><select v-model="formularioEdicion.es_plaza_temporal" class="input-texto"><option :value="false">No</option><option :value="true">Si</option></select></label>
              <label v-if="formularioEdicion.es_plaza_temporal"><span class="field-label">Plaza temporal</span><input v-model="formularioEdicion.plaza_temporal" class="input-texto"></label>
              <label class="edicion-field-wide"><span class="field-label">Motivo de edicion</span><textarea v-model="motivoEdicion" class="input-texto" rows="3" placeholder="Obligatorio"></textarea></label>
              <p v-if="motivoEdicionFaltante" class="inline-warning edicion-field-wide">Guardar se habilitará cuando ingreses el motivo de edición.</p>
            </fieldset>
            <div class="confirm-actions"><button type="button" class="boton boton-cancelar" :disabled="guardandoEdicion" @click="cancelarEdicion">Cancelar</button><button type="submit" class="boton boton-guardar" :disabled="guardandoEdicion || motivoEdicionFaltante" :title="motivoEdicionFaltante ? 'Ingresa el motivo de edición para guardar.' : ''">{{ guardandoEdicion ? 'Guardando...' : 'Guardar cambios' }}</button></div>
          </form>
          <div v-else class="detalle-body">
            <section v-for="section in seccionesDetalle" :key="section.title" class="detalle-section">
              <h4>{{ section.title }}</h4>
              <dl class="detalle-grid">
                <div v-for="field in section.fields" :key="field.key" class="detalle-field" :class="{ 'detalle-field-wide': field.image || typeof field.value === 'object' }">
                  <dt>{{ field.label }}</dt>
                  <dd v-if="field.image">
                    <a v-if="getFotoUrl(field.value, field.signedUrl)" :href="getFotoUrl(field.value, field.signedUrl)" target="_blank" rel="noreferrer"><img :src="getFotoUrl(field.value, field.signedUrl)" :alt="field.label" class="detalle-thumbnail"></a>
                    <span v-else>No disponible</span>
                  </dd>
                  <dd v-else-if="esUrl(field.value)"><a :href="field.value" target="_blank" rel="noreferrer" class="link-foto">Abrir enlace</a></dd>
                  <dd v-else>{{ formatearValor(field.value, field.key) }}</dd>
                </div>
              </dl>
            </section>
            <div v-if="canAdminister" class="confirm-actions"><button type="button" class="boton boton-eliminar" :disabled="!canEditActivaciones || deletingActivationId === activacionSeleccionada.id || !activacionSeleccionada.id" @click="eliminarActivacion(activacionSeleccionada)">{{ deletingActivationId === activacionSeleccionada.id ? 'Eliminando...' : 'Eliminar activacion' }}</button></div>
          </div>
        </aside>
      </div>
    </teleport>
  </div>
</template>
