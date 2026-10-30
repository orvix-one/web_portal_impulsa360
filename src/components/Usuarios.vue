<script setup>
import { computed, onMounted, ref } from 'vue'
import { adminApiRequest } from '../lib/adminApiClient'
import { useAuth } from '../lib/authStore'
import { notifyError, notifySuccess, notifyWarning, requestConfirmation, requestPasswordConfirmation } from '../lib/feedback'
import { containsNormalized, isValidEmail, normalizeEmail } from '../lib/textUtils'
import { deduplicarPlazas, deduplicarPlazasCatalogo, mismaPlaza } from '../lib/plazas'

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')
const roles = ['activador', 'lider', 'facturador', 'administrador', 'banco']
const estados = ['activo', 'inhabilitado']
const tiposZonaTemporal = [
  { value: 'universidad', label: 'Universidad' },
  { value: 'feria', label: 'Feria' },
  { value: 'evento', label: 'Evento' },
  { value: 'campana', label: 'Campaña' },
  { value: 'punto_temporal', label: 'Punto temporal' },
]
const { session, isAdmin } = useAuth()
const usuarios = ref([])
const loading = ref(false)
const procesando = ref(false)
const errorMsg = ref(null)
const busqueda = ref('')
const filtroRol = ref('')
const filtroEstado = ref('')
const filtroPlaza = ref('')
const filtroEquipoId = ref('')
const organizacion = ref({ available: false, message: '', plazas: [], equipos: [], facturadores: [] })

const nuevo = ref({ email: '', password: '', nombre: '', plaza: '', plaza_id: '', equipo_id: '', equipo_ids: [], facturador_equipo_ids: [], rol: 'activador', roles: ['activador'], estado: 'activo', lider_id: '', motivo_inhabilitacion: '', puede_activar: false })
const editandoId = ref(null)
const edicion = ref({})
const modalInhabilitar = ref(false)
const usuarioAInhabilitar = ref(null)
const motivoInhabilitar = ref('')
const usuarioPlazaTemporal = ref(null)
const plazaTemporalForm = ref({ plaza_temporal: '', tipo_zona: 'punto_temporal', ciudad_plaza: '', inicio: '', fin: '', motivo: '', activo: true })
const zonaEventoForm = ref({ plaza_temporal: '', tipo_zona: 'evento', ciudad_plaza: '', inicio: '', fin: '', motivo: '', activo: true, activador_ids: [] })

const lideresActivos = computed(() => usuarios.value.filter((u) => esRol(u, 'lider') && (u.estado ?? 'activo') === 'activo'))
const plazasCatalogo = computed(() => deduplicarPlazasCatalogo(organizacion.value.plazas))
const plazas = computed(() => organizacion.value.available
  ? plazasCatalogo.value.map((p) => ({ value: p.nombre, nombre: p.nombre }))
  : deduplicarPlazas(usuarios.value.map((u) => u.plaza_nombre || u.plaza_base || u.plaza)))
const equiposFiltro = computed(() => organizacion.value.equipos
  .filter((equipo) => equipo.activo)
  .map((equipo) => ({ id: equipo.id, etiqueta: etiquetaEquipo(equipo) })))
const usuariosPorId = computed(() => Object.fromEntries(usuarios.value.map((u) => [u.usuario_id, u])))
const activadoresActivos = computed(() => usuarios.value.filter((u) => esRol(u, 'activador') && (u.estado ?? 'activo') === 'activo'))
const usuariosFiltrados = computed(() => usuarios.value.filter((u) => {
  const coincideBusqueda = containsNormalized(u.nombre, busqueda.value) || containsNormalized(u.email, busqueda.value)
  const coincideEquipo = !filtroEquipoId.value ||
    u.equipo_id === filtroEquipoId.value ||
    u.equipos_asignados?.some((equipo) => equipo.id === filtroEquipoId.value) ||
    u.equipos_facturados?.some((equipo) => equipo.id === filtroEquipoId.value)
  return coincideBusqueda && (!filtroRol.value || esRol(u, filtroRol.value)) &&
    (!filtroEstado.value || (u.estado ?? 'activo') === filtroEstado.value) &&
    (!filtroPlaza.value || mismaPlaza(u.plaza_nombre || u.plaza_base || u.plaza, filtroPlaza.value)) &&
    coincideEquipo
}))

function requestAdmin(path, options = {}) {
  return adminApiRequest({ baseUrl: apiBaseUrl, path, token: session.value?.access_token, ...options })
}
function getErrorMessage(error) { return error instanceof Error && error.message ? error.message : 'Se produjo un error inesperado.' }
function etiqueta(valor) { return valor ? valor.charAt(0).toUpperCase() + valor.slice(1) : 'Sin asignar' }
function normalizarRol(value) { return String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() || 'activador' }
function rolesUsuario(usuario) { return Array.isArray(usuario?.roles) ? [...usuario.roles] : [normalizarRol(usuario?.rol)] }
function esRol(form, rol) { return rolesUsuario(form).includes(rol) }
function nombreLider(usuario) { return usuario.lider_id ? (usuariosPorId.value[usuario.lider_id]?.nombre ?? 'Lider no disponible') : 'Sin asignar' }
function equiposPara(form, rol) {
  return organizacion.value.equipos.filter((equipo) => {
    if (!equipo.activo) return false
    if (rol === 'activador') return true
    if (rol === 'lider') return true
    if (rol === 'facturador') return true
    return false
  })
}
function liderDelEquipo(form) {
  const equipo = organizacion.value.equipos.find((item) => item.id === form.equipo_id)
  return equipo?.lider_actual_id ? (usuariosPorId.value[equipo.lider_actual_id]?.nombre ?? 'Lider asignado') : 'Sin lider vigente'
}
function plazaDelEquipo(equipo) { return plazasCatalogo.value.find((item) => item.id === equipo.plaza_id)?.nombre ?? 'Sin plaza' }
function etiquetaEquipo(equipo) { return `#${equipo.numero} · ${plazaDelEquipo(equipo)}` }
function equiposDelUsuario(usuario) {
  const esLider = esRol(usuario, 'lider')
  const equiposFacturados = esRol(usuario, 'facturador') ? (usuario.equipos_facturados ?? []) : []
  if (!esLider && !equiposFacturados.length) return usuario.equipo_numero ? `#${usuario.equipo_numero}` : 'Sin equipo'
  const equipos = []
  const agregar = (equipo) => {
    if (equipo?.id && !equipos.some((item) => item.id === equipo.id)) equipos.push(equipo)
  }
  if (esLider) (usuario.equipos_asignados ?? []).forEach(agregar)
  equiposFacturados.forEach(agregar)
  if (!esLider && usuario.equipo_numero) {
    agregar({ id: usuario.equipo_id, numero: usuario.equipo_numero, plaza: usuario.plaza_nombre || usuario.plaza_base || usuario.plaza })
  }
  if (equipos.length) return equipos.map((e) => `#${e.numero}`).join(', ')
  return 'Sin equipo'
}
function ajustarRol(form) {
  form.rol = normalizarRol(form.rol)
  if (!esRol(form, 'activador')) { form.equipo_id = ''; form.plaza_id = ''; form.lider_id = ''; form.plaza = '' }
  if (!esRol(form, 'lider')) { form.equipo_ids = []; form.puede_activar = false }
  if (!esRol(form, 'facturador')) form.facturador_equipo_ids = []
}
function ajustarPlaza(form) {
  form.equipo_id = ''
  form.plaza = plazasCatalogo.value.find((item) => item.id === form.plaza_id)?.nombre ?? ''
}

async function cargarUsuarios() {
  if (!isAdmin.value) { errorMsg.value = 'Esta seccion requiere una sesion de administrador activo.'; return }
  loading.value = true; errorMsg.value = null
  try {
    const [result, org] = await Promise.all([
      requestAdmin('/admin/users'),
      requestAdmin('/admin/organization-options'),
    ])
    usuarios.value = result.users ?? []
    organizacion.value = org
  }
  catch (error) { errorMsg.value = getErrorMessage(error); notifyError(errorMsg.value) }
  finally { loading.value = false }
}
function validarFormulario(form, esEdicion = false) {
  if (!form.roles?.length || form.roles.some((rol) => !roles.includes(rol))) return 'Selecciona al menos un rol valido.'
  if (!form.nombre?.trim() || !normalizeEmail(form.email) || (!esEdicion && !form.password)) return 'Completa todos los campos obligatorios.'
  if (!isValidEmail(normalizeEmail(form.email))) return 'Ingresa un correo valido.'
  if (form.password && !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/.test(form.password)) return 'La contrasena debe tener al menos 10 caracteres, mayuscula, minuscula, numero y simbolo.'
  if (form.estado === 'inhabilitado' && !form.motivo_inhabilitacion?.trim()) return 'Ingresa el motivo de inhabilitacion.'
  return null
}
function payloadUsuario(form) {
  const payload = {
    email: normalizeEmail(form.email), nombre: form.nombre.trim(), plaza: form.plaza?.trim() ?? '',
    roles: [...form.roles], estado: form.estado, lider_id: !organizacion.value.available && esRol(form, 'activador') ? form.lider_id || null : null,
    puede_activar: esRol(form, 'lider') && form.puede_activar === true,
    motivo_inhabilitacion: form.estado === 'inhabilitado' ? form.motivo_inhabilitacion.trim() : null,
  }
  if (organizacion.value.available && esRol(form, 'activador')) payload.equipo_id = form.equipo_id
  if (organizacion.value.available && esRol(form, 'lider')) {
    payload.equipo_ids = form.equipo_ids ?? []
  }
  if (organizacion.value.available && esRol(form, 'facturador')) {
    payload.facturador_equipo_ids = form.facturador_equipo_ids ?? []
  }
  return payload
}
async function registrarUsuario() {
  const mensaje = validarFormulario(nuevo.value)
  if (mensaje) { notifyWarning(mensaje); return }
  procesando.value = true
  try {
    await requestAdmin('/admin/users', { method: 'POST', body: { ...payloadUsuario(nuevo.value), password: nuevo.value.password } })
    nuevo.value = { email: '', password: '', nombre: '', plaza: '', plaza_id: '', equipo_id: '', equipo_ids: [], facturador_equipo_ids: [], rol: 'activador', roles: ['activador'], estado: 'activo', lider_id: '', motivo_inhabilitacion: '', puede_activar: false }
    await cargarUsuarios(); notifySuccess('Usuario registrado correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
function editarUsuario(usuario) {
  editandoId.value = usuario.usuario_id
  const equipo = organizacion.value.equipos.find((item) => item.id === usuario.equipo_id)
  const equiposLider = organizacion.value.equipos.filter((item) => item.lider_actual_id === usuario.usuario_id)
  edicion.value = { nombre: usuario.nombre ?? '', email: usuario.email ?? '', plaza: usuario.plaza_base ?? usuario.plaza ?? '', plaza_id: equipo?.plaza_id ?? '', equipo_id: usuario.equipo_id ?? '', equipo_ids: equiposLider.map((item) => item.id), facturador_equipo_ids: usuario.equipos_facturados?.map((item) => item.id) ?? [], password: '', rol: normalizarRol(usuario.rol), roles: rolesUsuario(usuario), estado: usuario.estado ?? 'activo', lider_id: usuario.lider_id ?? '', motivo_inhabilitacion: usuario.motivo_inhabilitacion ?? '', puede_activar: usuario.puede_activar === true }
}
function cancelarEdicion() { editandoId.value = null; edicion.value = {} }
async function guardarEdicion() {
  const mensaje = validarFormulario(edicion.value, true)
  if (mensaje) { notifyWarning(mensaje); return }
  procesando.value = true
  const payload = payloadUsuario(edicion.value)
  if (edicion.value.password) payload.password = edicion.value.password
  try {
    await requestAdmin(`/admin/users/${editandoId.value}`, { method: 'PATCH', body: payload })
    cancelarEdicion(); await cargarUsuarios(); notifySuccess('Usuario actualizado correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
function abrirInhabilitacion(usuario) { usuarioAInhabilitar.value = usuario; motivoInhabilitar.value = ''; modalInhabilitar.value = true }
function cerrarInhabilitacion() { if (!procesando.value) { modalInhabilitar.value = false; usuarioAInhabilitar.value = null; motivoInhabilitar.value = '' } }
async function confirmarInhabilitacion() {
  const motivo = motivoInhabilitar.value.trim()
  if (!motivo) { notifyWarning('El motivo de inhabilitacion es obligatorio.'); return }
  procesando.value = true
  try {
    await requestAdmin(`/admin/users/${usuarioAInhabilitar.value.usuario_id}/status`, { method: 'PATCH', body: { estado: 'inhabilitado', motivo_inhabilitacion: motivo } })
    modalInhabilitar.value = false; usuarioAInhabilitar.value = null; motivoInhabilitar.value = ''
    await cargarUsuarios(); notifySuccess('Usuario inhabilitado correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
async function activarUsuario(usuario) {
  const aceptado = await requestConfirmation({ title: 'Activar usuario', message: `Se activara a ${usuario.nombre ?? 'este usuario'}.`, confirmLabel: 'Activar' })
  if (!aceptado) return
  procesando.value = true
  try {
    await requestAdmin(`/admin/users/${usuario.usuario_id}/status`, { method: 'PATCH', body: { estado: 'activo' } })
    await cargarUsuarios(); notifySuccess('Usuario activado correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
async function eliminarCuenta(usuario) {
  const password = await requestPasswordConfirmation({ title: 'Eliminar cuenta', message: 'Se eliminara permanentemente la cuenta de acceso de este usuario. El historial del usuario se conservara. Ingresa tu contrasena actual para confirmar.', confirmLabel: 'Eliminar cuenta' })
  if (!password) return
  procesando.value = true
  try { const result = await requestAdmin(`/admin/users/${usuario.usuario_id}`, { method: 'DELETE', body: { password } }); await cargarUsuarios(); notifySuccess(result.message ?? 'Cuenta de acceso eliminada correctamente.') }
  catch (error) { notifyError(error?.status === 409 && error.message && !error.message.startsWith('Error HTTP') ? error.message : getErrorMessage(error)) }
  finally { procesando.value = false }
}
function abrirPlazaTemporal(usuario) {
  usuarioPlazaTemporal.value = usuario
  plazaTemporalForm.value = { plaza_temporal: '', tipo_zona: 'punto_temporal', ciudad_plaza: usuario.plaza_nombre || usuario.plaza_base || usuario.plaza || '', inicio: '', fin: '', motivo: '', activo: true }
}
function cerrarPlazaTemporal() { if (!procesando.value) usuarioPlazaTemporal.value = null }
async function cambiarPlazaTemporal(usuario, event) {
  const enabled = event.target.checked
  event.target.checked = usuario.plaza_temporal_activa === true
  if (enabled) { abrirPlazaTemporal(usuario); return }
  procesando.value = true
  try {
    await requestAdmin(`/admin/users/${usuario.usuario_id}/temporary-plaza`, { method: 'DELETE' })
    await cargarUsuarios(); notifySuccess('Plaza temporal cancelada; vuelve a la plaza base.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
async function guardarPlazaTemporal() {
  const form = plazaTemporalForm.value
  if (!form.plaza_temporal.trim() || !form.inicio || !form.fin || !form.motivo.trim()) {
    notifyWarning('Completa zona temporal, inicio, fin y motivo.'); return
  }
  procesando.value = true
  try {
    await requestAdmin(`/admin/users/${usuarioPlazaTemporal.value.usuario_id}/temporary-plaza`, {
      method: 'POST', body: { ...form, inicio: new Date(form.inicio).toISOString(), fin: new Date(form.fin).toISOString() },
    })
    usuarioPlazaTemporal.value = null; await cargarUsuarios(); notifySuccess('Plaza temporal programada correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}
async function guardarZonaEvento() {
  const form = zonaEventoForm.value
  if (!form.plaza_temporal.trim() || !form.inicio || !form.fin || !form.motivo.trim() || !form.activador_ids.length) {
    notifyWarning('Completa zona/evento, fechas, motivo y al menos un activador.'); return
  }
  procesando.value = true
  try {
    const body = { ...form, inicio: new Date(form.inicio).toISOString(), fin: new Date(form.fin).toISOString() }
    for (const activadorId of form.activador_ids) {
      await requestAdmin(`/admin/users/${activadorId}/temporary-plaza`, { method: 'POST', body })
    }
    zonaEventoForm.value = { plaza_temporal: '', tipo_zona: 'evento', ciudad_plaza: '', inicio: '', fin: '', motivo: '', activo: true, activador_ids: [] }
    await cargarUsuarios(); notifySuccess('Zona/evento asignado correctamente.')
  } catch (error) { notifyError(getErrorMessage(error)) }
  finally { procesando.value = false }
}

onMounted(cargarUsuarios)
</script>

<template>
  <section class="view-page contenedor-usuarios">
    <header class="view-header">
      <p class="view-kicker">Control de Accesos</p><h1 class="view-title">Gestion de Usuarios</h1>
      <p class="view-description">Administra el equipo operativo conectado a la base principal de activaciones.</p>
      <div class="meta-row"><span class="meta-pill meta-pill-ok">Sesion administrativa</span></div>
    </header>
    <div class="forms-grid">
      <div class="formulario-registro">
        <h2 class="subtitulo">Registrar Usuario</h2>
        <p v-if="organizacion.message" class="panel-empty">{{ organizacion.message }}</p>
        <form class="formulario-campos" @submit.prevent="registrarUsuario">
          <input v-model="nuevo.email" type="email" placeholder="Correo electronico" class="input-texto"><input v-model="nuevo.password" type="password" placeholder="Contrasena" class="input-texto">
          <input v-model="nuevo.nombre" placeholder="Nombre completo" class="input-texto">
          <div role="group" aria-label="Roles" class="meta-row"><label v-for="rol in roles" :key="rol" class="scope-pill"><input v-model="nuevo.roles" type="checkbox" :value="rol" @change="ajustarRol(nuevo)"> {{ etiqueta(rol) }}</label></div>
          <select v-model="nuevo.estado" class="input-texto"><option v-for="estado in estados" :key="estado" :value="estado">{{ etiqueta(estado) }}</option></select>
          <template v-if="esRol(nuevo, 'activador')">
            <select v-if="organizacion.available" v-model="nuevo.plaza_id" class="input-texto" @change="ajustarPlaza(nuevo)"><option value="">Plaza base</option><option v-for="plaza in plazasCatalogo" :key="plaza.id" :value="plaza.id">{{ plaza.nombre }}</option></select>
            <input v-else v-model="nuevo.plaza" placeholder="Plaza base" class="input-texto">
            <select v-if="organizacion.available" v-model="nuevo.equipo_id" class="input-texto"><option value="">Sin equipo (asignar despues)</option><option v-for="equipo in equiposPara(nuevo, 'activador')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select>
            <span v-if="organizacion.available" class="field-label">Lider: {{ liderDelEquipo(nuevo) }}</span>
            <select v-else v-model="nuevo.lider_id" class="input-texto"><option value="">Sin lider</option><option v-for="lider in lideresActivos" :key="lider.usuario_id" :value="lider.usuario_id">{{ lider.nombre }}</option></select>
          </template>
          <template v-if="esRol(nuevo, 'lider') && organizacion.available">
            <label><span class="field-label">Equipos liderados (opcional)</span><select v-model="nuevo.equipo_ids" class="input-texto" multiple><option v-for="equipo in equiposPara(nuevo, 'lider')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select></label>
            <label class="scope-pill"><input v-model="nuevo.puede_activar" type="checkbox"> Puede realizar activaciones</label>
          </template>
          <label v-if="esRol(nuevo, 'facturador') && organizacion.available"><span class="field-label">Equipos facturados (opcional)</span><select v-model="nuevo.facturador_equipo_ids" class="input-texto" multiple><option v-for="equipo in equiposPara(nuevo, 'facturador')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select></label>
          <textarea v-if="nuevo.estado === 'inhabilitado'" v-model="nuevo.motivo_inhabilitacion" class="input-texto" placeholder="Motivo de inhabilitacion"></textarea>
          <button type="submit" class="boton boton-primario" :disabled="procesando">{{ procesando ? 'Guardando...' : 'Registrar' }}</button>
        </form>
      </div>
      <div class="formulario-registro">
        <h2 class="subtitulo">Zonas / eventos especiales</h2>
        <form class="formulario-campos" @submit.prevent="guardarZonaEvento">
          <input v-model="zonaEventoForm.plaza_temporal" placeholder="Nombre de zona/evento" class="input-texto">
          <select v-model="zonaEventoForm.tipo_zona" class="input-texto"><option v-for="tipo in tiposZonaTemporal" :key="tipo.value" :value="tipo.value">{{ tipo.label }}</option></select>
          <select v-if="organizacion.available" v-model="zonaEventoForm.ciudad_plaza" class="input-texto"><option value="">Ciudad/plaza</option><option v-for="plaza in plazasCatalogo" :key="plaza.id" :value="plaza.nombre">{{ plaza.nombre }}</option></select>
          <input v-else v-model="zonaEventoForm.ciudad_plaza" placeholder="Ciudad/plaza" class="input-texto">
          <label><span class="field-label">Inicio</span><input v-model="zonaEventoForm.inicio" type="datetime-local" class="input-texto"></label>
          <label><span class="field-label">Fin</span><input v-model="zonaEventoForm.fin" type="datetime-local" class="input-texto"></label>
          <textarea v-model="zonaEventoForm.motivo" class="input-texto" placeholder="Motivo obligatorio" rows="3"></textarea>
          <label class="scope-pill"><input v-model="zonaEventoForm.activo" type="checkbox"> Activo</label>
          <label><span class="field-label">Activadores asignados</span><select v-model="zonaEventoForm.activador_ids" class="input-texto" multiple><option v-for="usuario in activadoresActivos" :key="usuario.usuario_id" :value="usuario.usuario_id">{{ usuario.nombre || usuario.email }}</option></select></label>
          <button type="submit" class="boton boton-primario" :disabled="procesando">{{ procesando ? 'Guardando...' : 'Asignar zona/evento' }}</button>
        </form>
      </div>
    </div>
    <div class="panel-card tabla-contenedor">
      <div class="toolbar-line"><h2 class="subtitulo subtitulo-inline">Usuarios Registrados</h2><div class="toolbar-actions"><span class="meta-pill">{{ usuariosFiltrados.length }} visibles</span><button class="boton" :disabled="loading || procesando" @click="cargarUsuarios">Recargar</button></div></div>
      <div class="filtros filtros-grid filtros-usuarios">
        <label><span class="field-label">Nombre o correo</span><input v-model="busqueda" class="input-texto" placeholder="Buscar usuario"></label>
        <label><span class="field-label">Rol</span><select v-model="filtroRol" class="input-texto"><option value="">Todos</option><option v-for="rol in roles" :key="rol" :value="rol">{{ etiqueta(rol) }}</option></select></label>
        <label><span class="field-label">Estado</span><select v-model="filtroEstado" class="input-texto"><option value="">Todos</option><option v-for="estado in estados" :key="estado" :value="estado">{{ etiqueta(estado) }}</option></select></label>
        <label><span class="field-label">Plaza</span><select v-model="filtroPlaza" class="input-texto"><option value="">Todas</option><option v-for="item in plazas" :key="item.value" :value="item.value">{{ item.nombre }}</option></select></label>
        <label v-if="organizacion.available"><span class="field-label">Equipo</span><select v-model="filtroEquipoId" class="input-texto"><option value="">Todos</option><option v-for="equipo in equiposFiltro" :key="equipo.id" :value="equipo.id">{{ equipo.etiqueta }}</option></select></label>
      </div>
      <p v-if="loading">Cargando usuarios...</p><p v-else-if="errorMsg" class="mensaje-error">{{ errorMsg }}</p><p v-else-if="!usuariosFiltrados.length" class="panel-empty">No hay usuarios para los filtros seleccionados.</p>
      <div v-else class="table-wrap modulo-table-wrap"><table class="tabla-usuarios"><thead><tr><th>Nombre</th><th>Correo</th><th>Plaza base</th><th>Equipo</th><th>Líder actual</th><th>Facturador</th><th>Roles</th><th>Puede activar</th><th>Estado</th><th>Nueva contraseña</th><th>Acciones</th></tr></thead><tbody>
        <tr v-for="usuario in usuariosFiltrados" :key="usuario.usuario_id">
          <template v-if="editandoId === usuario.usuario_id">
            <td><input v-model="edicion.nombre" class="input-editar"></td><td><input v-model="edicion.email" type="email" class="input-editar"></td><td>
              <template v-if="esRol(edicion, 'activador')">
                <select v-if="organizacion.available" v-model="edicion.plaza_id" class="input-editar" @change="ajustarPlaza(edicion)"><option value="">Plaza base</option><option v-for="plaza in plazasCatalogo" :key="plaza.id" :value="plaza.id">{{ plaza.nombre }}</option></select>
                <input v-else v-model="edicion.plaza" class="input-editar">
              </template><span v-else>-</span>
            </td>
            <td>
              <template v-if="esRol(edicion, 'activador')">
                <select v-if="organizacion.available" v-model="edicion.equipo_id" class="input-editar"><option value="">Sin equipo (asignar despues)</option><option v-for="equipo in equiposPara(edicion, 'activador')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select>
                <select v-else v-model="edicion.lider_id" class="input-editar"><option value="">Sin lider</option><option v-for="lider in lideresActivos" :key="lider.usuario_id" :value="lider.usuario_id">{{ lider.nombre }}</option></select>
              </template>
              <label v-if="esRol(edicion, 'lider') && organizacion.available"><span class="field-label">Equipos liderados</span><select v-model="edicion.equipo_ids" class="input-editar" multiple><option v-for="equipo in equiposPara(edicion, 'lider')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select></label><span v-if="!esRol(edicion, 'activador') && !(esRol(edicion, 'lider') && organizacion.available)">-</span>
            </td>
            <td>{{ esRol(edicion, 'activador') ? liderDelEquipo(edicion) : '-' }}</td>
            <td><label v-if="esRol(edicion, 'facturador') && organizacion.available"><span class="field-label">Equipos facturados</span><select v-model="edicion.facturador_equipo_ids" class="input-editar" multiple><option v-for="equipo in equiposPara(edicion, 'facturador')" :key="equipo.id" :value="equipo.id">{{ etiquetaEquipo(equipo) }}</option></select></label><span v-else>{{ esRol(edicion, 'activador') ? (usuario.facturador_nombre || '-') : '-' }}</span></td>
            <td><div role="group" aria-label="Roles" class="meta-row"><label v-for="rol in roles" :key="rol" class="scope-pill"><input v-model="edicion.roles" type="checkbox" :value="rol" @change="ajustarRol(edicion)"> {{ etiqueta(rol) }}</label></div></td>
            <td><label v-if="esRol(edicion, 'lider')" class="scope-pill"><input v-model="edicion.puede_activar" type="checkbox"> Sí</label><span v-else>-</span></td>
            <td><select v-model="edicion.estado" class="input-editar"><option v-for="estado in estados" :key="estado" :value="estado">{{ etiqueta(estado) }}</option></select><textarea v-if="edicion.estado === 'inhabilitado'" v-model="edicion.motivo_inhabilitacion" class="input-editar" placeholder="Motivo obligatorio"></textarea></td>
            <td><input v-model="edicion.password" type="password" class="input-editar" placeholder="Opcional (contraseña fuerte)"></td><td><div class="acciones"><button class="boton boton-guardar" :disabled="procesando" @click="guardarEdicion">Guardar</button><button class="boton boton-cancelar" :disabled="procesando" @click="cancelarEdicion">Cancelar</button></div></td>
          </template>
          <template v-else>
            <td>{{ usuario.nombre || 'Sin nombre' }}<span v-if="usuario.organizacion_pendiente" class="scope-pill scope-pill-user">Organización pendiente</span></td><td>{{ usuario.email || 'Sin correo' }}</td><td>{{ usuario.plaza_nombre || usuario.plaza_base || usuario.plaza || 'Sin plaza' }}<span v-if="usuario.plaza_temporal_activa" class="scope-pill scope-pill-user">Temporal: {{ usuario.plaza_efectiva }}</span></td>
            <td>{{ equiposDelUsuario(usuario) }}</td><td>{{ nombreLider(usuario) }}</td><td>{{ usuario.facturador_nombre || '-' }}</td><td>{{ rolesUsuario(usuario).map(etiqueta).join(', ') }}</td>
            <td>{{ esRol(usuario, 'lider') ? (usuario.puede_activar === true ? 'Sí' : 'No') : '-' }}</td>
            <td><span class="estado-etiqueta" :class="`estado-${usuario.estado ?? 'activo'}`">{{ etiqueta(usuario.estado ?? 'activo') }}</span></td><td>-</td>
            <td><div class="acciones"><label v-if="esRol(usuario, 'activador')" class="scope-pill"><input type="checkbox" :checked="usuario.plaza_temporal_activa" :disabled="procesando" @change="cambiarPlazaTemporal(usuario, $event)"> Plaza temporal</label><button class="boton boton-editar" :disabled="procesando" @click="editarUsuario(usuario)">Editar</button><button v-if="(usuario.estado ?? 'activo') === 'activo'" class="boton boton-eliminar" :disabled="procesando" @click="abrirInhabilitacion(usuario)">Inhabilitar</button><button v-else class="boton boton-guardar" :disabled="procesando" @click="activarUsuario(usuario)">Activar</button><button v-if="(usuario.estado ?? 'activo') !== 'activo' && !usuario.cuenta_acceso_eliminada" class="boton boton-eliminar" :disabled="procesando" @click="eliminarCuenta(usuario)">Eliminar cuenta</button><span v-else-if="usuario.cuenta_acceso_eliminada" class="scope-pill">Cuenta eliminada</span></div></td>
          </template>
        </tr>
      </tbody></table></div>
    </div>
    <teleport to="body"><div v-if="modalInhabilitar" class="confirm-overlay" @click.self="cerrarInhabilitacion"><section class="confirm-modal" role="dialog" aria-modal="true" aria-label="Inhabilitar usuario"><h3 class="confirm-title">Inhabilitar usuario</h3><p class="confirm-message">Indica por que se inhabilitara a {{ usuarioAInhabilitar?.nombre ?? 'este usuario' }}.</p><textarea v-model="motivoInhabilitar" class="input-texto" placeholder="Motivo obligatorio" rows="4"></textarea><div class="confirm-actions"><button class="boton boton-cancelar" :disabled="procesando" @click="cerrarInhabilitacion">Cancelar</button><button class="boton boton-eliminar" :disabled="procesando || !motivoInhabilitar.trim()" @click="confirmarInhabilitacion">{{ procesando ? 'Guardando...' : 'Inhabilitar' }}</button></div></section></div></teleport>
    <teleport to="body"><div v-if="usuarioPlazaTemporal" class="confirm-overlay" @click.self="cerrarPlazaTemporal"><section class="confirm-modal" role="dialog" aria-modal="true" aria-label="Asignar plaza temporal"><h3 class="confirm-title">Plaza temporal</h3><p class="confirm-message">Asignación temporal para {{ usuarioPlazaTemporal.nombre }}. Su plaza base no cambiará.</p><select v-if="organizacion.available" v-model="plazaTemporalForm.plaza_temporal" class="input-texto"><option value="">Plaza temporal</option><option v-for="plaza in plazasCatalogo" :key="plaza.id" :value="plaza.nombre">{{ plaza.nombre }}</option></select><input v-else v-model="plazaTemporalForm.plaza_temporal" class="input-texto" placeholder="Plaza temporal"><select v-model="plazaTemporalForm.tipo_zona" class="input-texto"><option v-for="tipo in tiposZonaTemporal" :key="tipo.value" :value="tipo.value">{{ tipo.label }}</option></select><input v-model="plazaTemporalForm.ciudad_plaza" class="input-texto" placeholder="Ciudad/plaza"><label><span class="field-label">Inicio</span><input v-model="plazaTemporalForm.inicio" type="datetime-local" class="input-texto"></label><label><span class="field-label">Fin</span><input v-model="plazaTemporalForm.fin" type="datetime-local" class="input-texto"></label><textarea v-model="plazaTemporalForm.motivo" class="input-texto" placeholder="Motivo obligatorio" rows="3"></textarea><label class="scope-pill"><input v-model="plazaTemporalForm.activo" type="checkbox"> Activo</label><div class="confirm-actions"><button class="boton boton-cancelar" :disabled="procesando" @click="cerrarPlazaTemporal">Cancelar</button><button class="boton boton-guardar" :disabled="procesando" @click="guardarPlazaTemporal">{{ procesando ? 'Guardando...' : 'Asignar' }}</button></div></section></div></teleport>
  </section>
</template>

<style scoped>
[role="group"][aria-label="Roles"] .scope-pill {
  color: var(--ru-ink);
}
</style>
