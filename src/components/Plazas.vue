<script setup>
import { ref, onMounted } from 'vue'
import { adminApiRequest } from '../lib/adminApiClient'
import { useAuth } from '../lib/authStore'
import { notifyError, notifySuccess, notifyWarning, requestPasswordConfirmation } from '../lib/feedback'

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')
const { session } = useAuth()
const plazas = ref([])
const loading = ref(false)
const procesando = ref(false)
const nuevo = ref(plazaVacia())
const editandoId = ref(null)
const edicion = ref({})
const eliminandoId = ref(null)
const modalReasignar = ref(false)
const plazaPendiente = ref(null)
const plazaDestino = ref('')

function plazaVacia() { return { nombre: '', es_ciudad_geografica: false, aliases: '' } }

function request(path, options = {}) {
  return adminApiRequest({ baseUrl: apiBaseUrl, path, token: session.value?.access_token, ...options })
}
function requestWithTimeout(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return request(path, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

function errorMessage(error) { return error instanceof Error ? error.message : 'Error inesperado.' }

async function cargar() {
  loading.value = true
  try {
    const result = await request('/admin/plazas')
    plazas.value = result.plazas ?? []
  } catch (error) { notifyError(errorMessage(error)) }
  finally { loading.value = false }
}

async function crear() {
  if (!nuevo.value.nombre.trim()) { notifyWarning('Nombre de plaza es obligatorio.'); return }
  procesando.value = true
  try {
    await request('/admin/plazas', { method: 'POST', body: { ...nuevo.value, nombre: nuevo.value.nombre.trim() } })
    nuevo.value = plazaVacia()
    await cargar(); notifySuccess('Plaza creada correctamente.')
  } catch (error) { notifyError(errorMessage(error)) }
  finally { procesando.value = false }
}

function editar(plaza) {
  editandoId.value = plaza.id
  edicion.value = {
    nombre: plaza.nombre,
    activa: plaza.activa,
    es_ciudad_geografica: plaza.es_ciudad_geografica === true,
    aliases: (plaza.aliases ?? []).join(', '),
  }
}
function cancelar() { editandoId.value = null; edicion.value = {} }
async function guardar(plaza) {
  if (!edicion.value.nombre || typeof edicion.value.activa !== 'boolean') { notifyWarning('Nombre y estado son obligatorios.'); return }
  procesando.value = true
  try {
    await request(`/admin/plazas/${plaza.id}`, { method: 'PATCH', body: edicion.value })
    cancelar(); await cargar(); notifySuccess('Plaza actualizada correctamente.')
  } catch (error) { notifyError(errorMessage(error)) }
  finally { procesando.value = false }
}

async function cambiarEstado(plaza) {
  procesando.value = true
  try {
    await request(`/admin/plazas/${plaza.id}`, { method: 'PATCH', body: { activa: !plaza.activa } })
    await cargar(); notifySuccess(plaza.activa ? 'Plaza desactivada.' : 'Plaza activada.')
  } catch (error) { notifyError(errorMessage(error)) }
  finally { procesando.value = false }
}

async function deshabilitarPlaza(plaza) {
  if (!plaza) return
  if (plaza.activa === false) {
    modalReasignar.value = false
    plazaPendiente.value = null
    return
  }
  procesando.value = true
  try {
    await request(`/admin/plazas/${plaza.id}`, { method: 'PATCH', body: { activa: false } })
    modalReasignar.value = false
    plazaPendiente.value = null
    await cargar(); notifySuccess('Plaza desactivada.')
  } catch (error) { notifyError(errorMessage(error)) }
  finally { procesando.value = false }
}

async function eliminarPlaza(plaza) {
  const password = await requestPasswordConfirmation({ title: 'Eliminar plaza', message: 'Ingresa tu contraseña actual para eliminar definitivamente esta plaza.', confirmLabel: 'Eliminar definitivamente' })
  if (!password) return
  eliminandoId.value = plaza.id
  procesando.value = true
  try {
    const result = await request(`/admin/plazas/${plaza.id}`, { method: 'DELETE', body: { password } })
    await cargar();
    notifySuccess(result.message ?? 'Operación realizada.')
  } catch (error) {
    if (error?.status === 409) { plazaPendiente.value = plaza; plazaDestino.value = ''; modalReasignar.value = true }
    else notifyError(errorMessage(error))
  }
  finally { procesando.value = false; eliminandoId.value = null }
}
async function reasignarYEliminar() {
  const destino = plazas.value.find((item) => item.id === plazaDestino.value && item.activa && item.id !== plazaPendiente.value?.id)
  if (!destino) { notifyWarning('Selecciona una plaza activa de destino.'); return }
  modalReasignar.value = false
  const password = await requestPasswordConfirmation({ title: 'Reasignar y eliminar', message: 'Ingresa tu contraseña actual. Se reasignarán las relaciones y se eliminará la plaza original.', confirmLabel: 'Reasignar y eliminar' })
  if (!password) { modalReasignar.value = true; return }
  procesando.value = true
  try { const result = await requestWithTimeout(`/admin/plazas/${plazaPendiente.value.id}/reassign-delete`, { method: 'POST', body: { destino_id: destino.id, password } }); plazaPendiente.value = null; await cargar(); notifySuccess(result.message ?? 'Plaza reasignada y eliminada.') }
  catch (error) { notifyError(error?.name === 'AbortError' ? 'La operación tardó demasiado. Inténtalo nuevamente.' : (error?.status === 409 ? error.message : errorMessage(error))) }
  finally { procesando.value = false }
}

onMounted(cargar)
</script>

<template>
  <section class="view-page">
    <header class="view-header"><p class="view-kicker">Organizacion</p><h1 class="view-title">Plazas</h1><p class="view-description">Gestiona el catálogo de plazas del sistema.</p></header>
    <div class="forms-grid">
      <div class="formulario-registro"><h2 class="subtitulo">Crear plaza</h2><form class="formulario-campos" @submit.prevent="crear">
        <input v-model="nuevo.nombre" placeholder="Nombre de plaza" class="input-texto">
        <label><input v-model="nuevo.es_ciudad_geografica" type="checkbox"> Ciudad visible en la app móvil</label>
        <input v-if="nuevo.es_ciudad_geografica" v-model="nuevo.aliases" placeholder="Aliases GPS, separados por coma" class="input-texto">
        <button class="boton boton-primario" :disabled="procesando">Crear plaza</button>
      </form></div>
    </div>

    <p v-if="loading">Cargando plazas...</p>
    <div v-else class="panel-card tabla-contenedor">
      <div class="toolbar-line"><h2 class="subtitulo subtitulo-inline">Plazas</h2><span class="meta-pill">{{ plazas.length }}</span></div>
      <div class="table-wrap modulo-table-wrap"><table><thead><tr><th>Nombre</th><th>Estado</th><th>Ciudad en app</th><th>Aliases GPS</th><th>Acciones</th></tr></thead><tbody>
        <tr v-for="plaza in plazas" :key="plaza.id">
          <template v-if="editandoId === plaza.id">
            <td><input v-model="edicion.nombre" class="input-editar"></td>
            <td><select v-model="edicion.activa" class="input-editar"><option :value="true">Activa</option><option :value="false">Inactiva</option></select></td>
            <td><select v-model="edicion.es_ciudad_geografica" class="input-editar"><option :value="true">Sí</option><option :value="false">No</option></select></td>
            <td><input v-model="edicion.aliases" placeholder="Separados por coma" class="input-editar"></td>
            <td><button class="boton boton-guardar" :disabled="procesando" @click="guardar(plaza)">Guardar</button><button class="boton boton-cancelar" @click="cancelar">Cancelar</button></td>
          </template>
          <template v-else>
            <td>{{ plaza.nombre }}</td>
            <td><span class="scope-pill" :class="plaza.activa ? 'scope-pill-all' : 'scope-pill-user'">{{ plaza.activa ? 'Activa' : 'Inactiva' }}</span></td>
            <td>{{ plaza.es_ciudad_geografica ? 'Sí' : 'No' }}</td>
            <td>{{ (plaza.aliases ?? []).join(', ') }}</td>
            <td>
              <button class="boton boton-editar" @click="editar(plaza)">Editar</button>
              <button class="boton" :disabled="procesando" @click="cambiarEstado(plaza)">{{ plaza.activa ? 'Desactivar' : 'Activar' }}</button>
              <button class="boton boton-eliminar" :disabled="procesando || eliminandoId===plaza.id" @click="eliminarPlaza(plaza)">{{ eliminandoId===plaza.id ? 'Procesando...' : 'Eliminar' }}</button>
            </td>
          </template>
        </tr>
      </tbody></table></div>
    </div>
    <teleport to="body"><div v-if="modalReasignar" class="confirm-overlay" @click.self="modalReasignar = false"><section class="confirm-modal" role="dialog" aria-modal="true"><h3 class="confirm-title">Eliminar plaza</h3><p class="confirm-message">La plaza tiene relaciones. Elige una acción.</p><div class="confirm-actions"><button class="boton boton-cancelar" @click="modalReasignar = false">Cancelar</button><button class="boton" :disabled="procesando" @click="deshabilitarPlaza(plazaPendiente)">Deshabilitar plaza</button></div><select v-model="plazaDestino" class="input-texto"><option value="">Plaza activa de destino</option><option v-for="item in plazas.filter((p) => p.activa && p.id !== plazaPendiente?.id)" :key="item.id" :value="item.id">{{ item.nombre }}</option></select><button class="boton boton-eliminar" :disabled="procesando || !plazaDestino" @click="reasignarYEliminar">Reasignar y eliminar</button></section></div></teleport>
  </section>
</template>
