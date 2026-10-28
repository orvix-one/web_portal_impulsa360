<script setup>
import { computed, onMounted, ref } from 'vue'
import { adminApiRequest } from '../lib/adminApiClient'
import { useAuth } from '../lib/authStore'
import { notifyError, notifySuccess, notifyWarning } from '../lib/feedback'
import { containsNormalized } from '../lib/textUtils'

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')

const { session, isAdmin } = useAuth()
const initializing = ref(true)
const accessError = ref(null)

const usuarios = ref([])
const notificaciones = ref([])
const cargandoNotificaciones = ref(false)
const errorNotificaciones = ref(null)
const enviando = ref(false)

const titulo = ref('')
const mensaje = ref('')
const alcance = ref('all')
const usuarioObjetivoIds = ref([])
const busquedaUsuario = ref('')

const filtroTexto = ref('')
const filtroAlcance = ref('')

const formatDateTime = new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/La_Paz',
})

const usuariosOrdenados = computed(() => {
  return [...usuarios.value].sort((a, b) => {
    const left = (a.nombre || a.email || '').toLowerCase()
    const right = (b.nombre || b.email || '').toLowerCase()
    return left.localeCompare(right, 'es', { sensitivity: 'base' })
  })
})
const usuariosSeleccionables = computed(() => usuariosOrdenados.value.filter((usuario) =>
  containsNormalized(usuario.nombre, busquedaUsuario.value) || containsNormalized(usuario.email, busquedaUsuario.value)))

const notificacionesFiltradas = computed(() => {
  return notificaciones.value.filter((item) => {
    const targetLabel = `${getTargetLabel(item)} ${item.usuarioObjetivo?.nombre || ''} ${item.usuarioObjetivo?.email || ''}`

    const coincideTexto =
      containsNormalized(item.titulo, filtroTexto.value) ||
      containsNormalized(item.mensaje, filtroTexto.value) ||
      containsNormalized(item.creado_por, filtroTexto.value) ||
      containsNormalized(targetLabel, filtroTexto.value)

    const coincideAlcance = !filtroAlcance.value || (item.tipo_audiencia ?? item.alcance) === filtroAlcance.value

    return coincideTexto && coincideAlcance
  })
})

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Se produjo un error inesperado.'
}

function getTargetLabel(item) {
  const audience = item.tipo_audiencia ?? (item.alcance === 'user' ? 'users' : 'all')
  if (audience === 'all') return 'Todos los usuarios activos'
  if (audience === 'role') return `${etiquetaRol(item.rol_objetivo)} activos`
  if ((item.destinatarios_total ?? 0) > 1) return `${item.destinatarios_total} usuarios específicos`

  if (!item.usuarioObjetivo) {
    return 'Usuario especifico'
  }

  return item.usuarioObjetivo.nombre || item.usuarioObjetivo.email || item.usuarioObjetivo.usuario_id
}
function etiquetaRol(rol) { return ({ activador: 'Activadores', lider: 'Líderes', facturador: 'Facturadores' }[rol] ?? 'Rol') }
function getAudienceLabel(item) {
  const audience = item.tipo_audiencia ?? (item.alcance === 'user' ? 'users' : 'all')
  if (audience === 'role') return etiquetaRol(item.rol_objetivo)
  return audience === 'users' ? 'Usuarios específicos' : 'Todos'
}

function getMessagePreview(text) {
  const normalized = typeof text === 'string' ? text.trim() : ''
  if (normalized.length <= 110) {
    return normalized
  }

  return `${normalized.slice(0, 107)}...`
}

function formatCreatedAt(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return formatDateTime.format(date)
}

function resetForm() {
  titulo.value = ''
  mensaje.value = ''
  alcance.value = 'all'
  usuarioObjetivoIds.value = []
  busquedaUsuario.value = ''
}

async function requestAdmin(path, options = {}) {
  return adminApiRequest({
    baseUrl: apiBaseUrl,
    path,
    token: session.value?.access_token,
    ...options,
  })
}

async function cargarUsuarios() {
  const result = await requestAdmin('/admin/users')
  usuarios.value = (result.users ?? []).filter((usuario) => (usuario.estado ?? 'activo') === 'activo')
}

async function cargarNotificaciones() {
  cargandoNotificaciones.value = true
  errorNotificaciones.value = null

  try {
    const result = await requestAdmin('/admin/notifications?limit=120')
    notificaciones.value = result.notifications ?? []
  } catch (error) {
    errorNotificaciones.value = getErrorMessage(error)
    notifyError(errorNotificaciones.value)
  } finally {
    cargandoNotificaciones.value = false
  }
}

async function enviarNotificacion() {
  if (!isAdmin.value || enviando.value) {
    return
  }

  const tituloNormalizado = titulo.value.trim()
  const mensajeNormalizado = mensaje.value.trim()

  if (tituloNormalizado.length < 3) {
    notifyWarning('El titulo debe tener al menos 3 caracteres.')
    return
  }

  if (mensajeNormalizado.length < 3) {
    notifyWarning('El mensaje debe tener al menos 3 caracteres.')
    return
  }

  if (alcance.value === 'users' && !usuarioObjetivoIds.value.length) {
    notifyWarning('Selecciona al menos un usuario para el envio especifico.')
    return
  }

  enviando.value = true

  try {
    const payload = {
      titulo: tituloNormalizado,
      mensaje: mensajeNormalizado,
      tipoAudiencia: alcance.value === 'all' ? 'all' : alcance.value === 'users' ? 'users' : 'role',
      rolObjetivo: ['activador', 'lider', 'facturador'].includes(alcance.value) ? alcance.value : null,
      usuarioObjetivoIds: alcance.value === 'users' ? usuarioObjetivoIds.value : [],
    }

    const result = await requestAdmin('/admin/notifications', {
      method: 'POST',
      body: payload,
    })

    const enviados = result?.notification?.destinatarios_total ?? 0
    resetForm()
    await cargarNotificaciones()
    notifySuccess(`Notificacion enviada. Destinatarios: ${enviados}.`)
  } catch (error) {
    notifyError(getErrorMessage(error))
  } finally {
    enviando.value = false
  }
}

onMounted(async () => {
  if (!isAdmin.value) {
    accessError.value = 'Este modulo esta disponible solo para administradores activos.'
    initializing.value = false
    return
  }

  try {
    await Promise.all([cargarUsuarios(), cargarNotificaciones()])
  } catch (error) {
    accessError.value = getErrorMessage(error)
    notifyError(accessError.value)
  } finally {
    initializing.value = false
  }
})
</script>

<template>
  <section class="view-page">
    <header class="view-header">
      <p class="view-kicker">Comunicacion Operativa</p>
      <h1 class="view-title">Notificaciones Internas</h1>
      <p class="view-description">
        Envia comunicados internos a todos los usuarios o a un usuario especifico y revisa el
        estado de lectura.
      </p>
      <div class="meta-row">
        <span class="meta-pill" :class="{ 'meta-pill-ok': isAdmin }">Sesion administrativa</span>
      </div>
    </header>

    <p v-if="initializing">Cargando modulo...</p>
    <p v-else-if="accessError" class="mensaje-error">{{ accessError }}</p>
    <div v-else class="forms-grid">
      <div class="formulario-registro">
        <h2 class="subtitulo">Nuevo Envio</h2>
        <form class="formulario-campos" @submit.prevent="enviarNotificacion">
          <label>
            <span class="field-label">Titulo</span>
            <input
              v-model="titulo"
              class="input-texto"
              type="text"
              maxlength="120"
              placeholder="Ej: Recordatorio de corte diario"
              @keydown.enter.prevent="enviarNotificacion"
            />
          </label>

          <label>
            <span class="field-label">Mensaje</span>
            <textarea
              v-model="mensaje"
              class="textarea-texto"
              rows="4"
              maxlength="2000"
              placeholder="Escribe el contenido de la notificacion..."
            />
          </label>

          <label>
            <span class="field-label">Audiencia</span>
            <select v-model="alcance" class="input-texto">
              <option value="all">Todos</option>
              <option value="activador">Activadores</option>
              <option value="lider">Líderes</option>
              <option value="facturador">Facturadores</option>
              <option value="users">Usuarios específicos</option>
            </select>
          </label>

          <div v-if="alcance === 'users'">
            <label><span class="field-label">Buscar usuarios activos</span><input v-model="busquedaUsuario" class="input-texto" placeholder="Nombre o correo"></label>
            <div class="notification-user-picker">
              <label v-for="usuario in usuariosSeleccionables" :key="usuario.usuario_id" class="scope-pill">
                <input v-model="usuarioObjetivoIds" type="checkbox" :value="usuario.usuario_id">
                {{ usuario.nombre || usuario.email }} · {{ etiquetaRol(usuario.rol) }}
              </label>
            </div>
            <span class="field-label">{{ usuarioObjetivoIds.length }} seleccionados</span>
          </div>

          <button
            type="submit"
            class="boton boton-primario"
            :disabled="enviando"
          >
            {{ enviando ? 'Enviando...' : 'Enviar Notificacion' }}
          </button>
        </form>
      </div>
    </div>

    <div v-if="!initializing && !accessError" class="panel-card">
      <div class="toolbar-line">
        <h2 class="subtitulo subtitulo-inline">Historial de Envios</h2>
        <div class="toolbar-actions">
          <span class="meta-pill">{{ notificacionesFiltradas.length }} visibles</span>
          <button class="boton" @click="cargarNotificaciones">Recargar</button>
        </div>
      </div>

      <div class="filtros filtros-grid filtros-lista">
        <label>
          <span class="field-label">Buscar</span>
          <input
            v-model="filtroTexto"
            type="text"
            placeholder="Titulo, mensaje, usuario o creador"
            class="input-texto"
          />
        </label>
        <label>
          <span class="field-label">Alcance</span>
          <select v-model="filtroAlcance" class="input-texto">
            <option value="">Todos</option>
            <option value="all">Todos</option>
            <option value="role">Por rol</option>
            <option value="users">Usuarios específicos</option>
          </select>
        </label>
      </div>

      <p v-if="cargandoNotificaciones">Cargando historial...</p>
      <p v-else-if="errorNotificaciones" class="mensaje-error">{{ errorNotificaciones }}</p>
      <p v-else-if="notificacionesFiltradas.length === 0" class="panel-empty">
        No hay notificaciones para los filtros seleccionados.
      </p>

      <div v-else class="table-wrap modulo-table-wrap">
        <table class="tabla-usuarios">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Titulo</th>
              <th>Mensaje</th>
              <th>Alcance</th>
              <th>Destino</th>
              <th>Enviadas</th>
              <th>Leidas</th>
              <th>Pendientes</th>
              <th>Creado por</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in notificacionesFiltradas" :key="item.id">
              <td>{{ formatCreatedAt(item.created_at) }}</td>
              <td>{{ item.titulo }}</td>
              <td>
                <details class="notification-message-details">
                  <summary>{{ getMessagePreview(item.mensaje) }}</summary>
                  <p>{{ item.mensaje }}</p>
                </details>
              </td>
              <td>
                <span class="scope-pill" :class="(item.tipo_audiencia ?? item.alcance) === 'all' ? 'scope-pill-all' : 'scope-pill-user'">
                  {{ getAudienceLabel(item) }}
                </span>
              </td>
              <td :title="item.usuarioObjetivo?.email || ''">{{ getTargetLabel(item) }}</td>
              <td><span class="notification-stat notification-stat-sent">{{ item.destinatarios_total }}</span></td>
              <td><span class="notification-stat notification-stat-read">{{ item.destinatarios_leidos }}</span></td>
              <td><span class="notification-stat notification-stat-pending">{{ item.destinatarios_pendientes }}</span></td>
              <td>{{ item.creado_por }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
