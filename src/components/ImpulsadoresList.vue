<script setup>
import { computed, onMounted, ref } from 'vue'
import { portalRequest } from '../lib/activacionesService'
import { containsNormalized } from '../lib/textUtils'
import { notifyError, notifyInfo, notifySuccess } from '../lib/feedback'
import { deduplicarPlazas, mismaPlaza, nombreLegiblePlaza } from '../lib/plazas'
import { neutralizeExportRow } from '../lib/exportSafety'
import { logClientError } from '../lib/logging'

const impulsadores = ref([])
const loading = ref(true)
const errorMsg = ref(null)
const filtroNombre = ref('')
const filtroEmail = ref('')
const filtroPlaza = ref('')
const filtroEquipo = ref('')
const filtroLider = ref('')
const filtroFacturador = ref('')
const filtroEstado = ref('')
const exportandoExcel = ref(false)

const plazas = computed(() => deduplicarPlazas(impulsadores.value.map((i) => i.plaza_nombre || i.plaza_base || i.plaza)))
const equipos = computed(() => [...new Map(impulsadores.value.filter((i) => i.equipo_numero).map((i) => [String(i.equipo_numero), `#${i.equipo_numero} - ${i.equipo_nombre || 'Equipo'}`])).entries()])
const lideres = computed(() => [...new Map(impulsadores.value.filter((i) => i.lider_id).map((i) => [i.lider_id, nombreLider(i)])).entries()])
const facturadores = computed(() => [...new Map(impulsadores.value.filter((i) => i.facturador_id).map((i) => [i.facturador_id, i.facturador_nombre || i.facturador_codigo || 'Facturador'])).entries()])

function nombreLider(impulsador) {
  if (!impulsador.lider_id) return '-'
  return impulsador.lider_nombre || impulsadores.value.find((item) => item.usuario_id === impulsador.lider_id)?.nombre || 'No disponible'
}

const impulsadoresFiltrados = computed(() => {
  return impulsadores.value.filter((impulsador) => {
    const coincideNombre = containsNormalized(impulsador.nombre, filtroNombre.value)
    const coincideEmail = containsNormalized(impulsador.email, filtroEmail.value)
    const coincidePlaza = !filtroPlaza.value || mismaPlaza(impulsador.plaza_nombre || impulsador.plaza_base || impulsador.plaza, filtroPlaza.value)
    const coincideEquipo = !filtroEquipo.value || String(impulsador.equipo_numero ?? '') === filtroEquipo.value
    const coincideLider = !filtroLider.value || impulsador.lider_id === filtroLider.value
    const coincideFacturador = !filtroFacturador.value || impulsador.facturador_id === filtroFacturador.value
    const coincideEstado = !filtroEstado.value || (impulsador.estado || 'activo') === filtroEstado.value

    return (impulsador.rol ?? 'activador') === 'activador' && coincideNombre && coincideEmail && coincidePlaza && coincideEquipo && coincideLider && coincideFacturador && coincideEstado
  })
})

const columnasExcel = [
  ['#', (_row, index) => index + 1],
  ['Nombre', (row) => row.nombre],
  ['Email', (row) => row.email],
  ['Plaza base', (row) => nombreLegiblePlaza(row.plaza_nombre || row.plaza_base || row.plaza)],
  ['Facturador', (row) => row.facturador_nombre || row.facturador_codigo || '-'],
  ['Estado', (row) => row.estado || 'Sin estado'],
  ['Lider', (row) => nombreLider(row)],
  ['Equipo', (row) => row.equipo_numero ? `#${row.equipo_numero} - ${row.equipo_nombre || 'Equipo'}` : '-'],
  ['Plaza temporal', (row) => row.plaza_temporal_activa ? row.plaza_efectiva : '-'],
  ['Usuario ID', (row) => row.usuario_id],
]

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

async function exportarImpulsadoresExcel() {
  const datos = impulsadoresFiltrados.value
  if (!datos.length) {
    notifyInfo('No hay impulsadores para exportar con los filtros actuales.')
    return
  }

  exportandoExcel.value = true
  try {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.creator = 'Impulsa 360'
    workbook.created = new Date()
    const worksheet = workbook.addWorksheet('Impulsadores')
    worksheet.columns = columnasExcel.map(([header]) => ({
      header,
      key: header,
      width: Math.max(12, Math.min(34, String(header).length + 8)),
    }))
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1769FF' } }
    worksheet.getRow(1).alignment = { vertical: 'middle' }

    datos.forEach((row, index) => {
      worksheet.addRow(neutralizeExportRow(Object.fromEntries(columnasExcel.map(([header, getValue]) => [header, getValue(row, index) ?? '']))))
    })
    worksheet.views = [{ state: 'frozen', ySplit: 1 }]
    worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(columnasExcel.length).letter}1` }
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          left: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          bottom: { style: 'thin', color: { argb: 'FFDCE8F4' } },
          right: { style: 'thin', color: { argb: 'FFDCE8F4' } },
        }
      })
    })

    descargarArchivo({
      filename: 'impulsadores.xlsx',
      content: await workbook.xlsx.writeBuffer(),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    notifySuccess(`Excel exportado con ${datos.length} impulsadores.`)
  } catch (error) {
    logClientError('impulsadores.export.excel', error)
    notifyError(error instanceof Error ? error.message : 'No se pudo exportar el Excel.')
  } finally {
    exportandoExcel.value = false
  }
}

onMounted(async () => {
  loading.value = true
  errorMsg.value = null

  try {
    const data = await portalRequest('/portal/users')
    impulsadores.value = data.users ?? []
  } catch (error) {
    logClientError('impulsadores.fetch', error)
    errorMsg.value = 'Error al obtener los impulsadores.'
  }

  loading.value = false
})
</script>

<template>
  <div class="contenedor-impulsadores section-block">
    <div class="section-head">
      <h2 class="section-title">Lista de Impulsadores Registrados</h2>
      <p class="section-caption">Usuarios disponibles para la operacion en campo.</p>
    </div>

    <div class="filtros filtros-grid filtros-lista">
      <label>
        <span class="field-label">Nombre</span>
        <input
          v-model="filtroNombre"
          type="text"
          placeholder="Buscar por nombre"
          class="input-texto"
        />
      </label>
      <label>
        <span class="field-label">Email</span>
        <input
          v-model="filtroEmail"
          type="text"
          placeholder="Buscar por email"
          class="input-texto"
        />
      </label>
      <label>
        <span class="field-label">Plaza</span>
        <select v-model="filtroPlaza" class="input-texto"><option value="">Todas</option><option v-for="plaza in plazas" :key="plaza.key" :value="plaza.value">{{ plaza.nombre }}</option></select>
      </label>
      <label><span class="field-label">Equipo</span><select v-model="filtroEquipo" class="input-texto"><option value="">Todos</option><option v-for="[id, nombre] in equipos" :key="id" :value="id">{{ nombre }}</option></select></label>
      <label><span class="field-label">Lider</span><select v-model="filtroLider" class="input-texto"><option value="">Todos</option><option v-for="[id, nombre] in lideres" :key="id" :value="id">{{ nombre }}</option></select></label>
      <label><span class="field-label">Facturador</span><select v-model="filtroFacturador" class="input-texto"><option value="">Todos</option><option v-for="[id, nombre] in facturadores" :key="id" :value="id">{{ nombre }}</option></select></label>
      <label><span class="field-label">Estado</span><select v-model="filtroEstado" class="input-texto"><option value="">Todos</option><option value="activo">Activo</option><option value="inhabilitado">Inhabilitado</option></select></label>
    </div>

    <div class="toolbar-line">
      <span class="meta-pill">{{ impulsadoresFiltrados.length }} visibles</span>
      <button type="button" class="boton-exportar" :disabled="loading || exportandoExcel || !impulsadoresFiltrados.length" @click="exportarImpulsadoresExcel">{{ exportandoExcel ? 'Generando Excel...' : 'Exportar Excel' }}</button>
    </div>

    <p v-if="loading">Cargando...</p>
    <p v-else-if="errorMsg" class="mensaje-error">{{ errorMsg }}</p>
    <p v-else-if="impulsadoresFiltrados.length === 0" class="panel-empty">
      No hay impulsadores para los filtros seleccionados.
    </p>

    <div v-else class="table-wrap modulo-table-wrap">
      <table class="tabla-impulsadores">
        <thead>
          <tr>
            <th>#</th>
            <th>Nombre</th>
            <th>Email</th>
            <th>Plaza base</th>
            <th>Facturador</th>
            <th>Estado</th>
            <th>Lider</th>
            <th>Equipo</th>
            <th>Plaza temporal</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(impulsador, index) in impulsadoresFiltrados"
            :key="impulsador.usuario_id"
          >
            <td>{{ index + 1 }}</td>
            <td>{{ impulsador.nombre }}</td>
            <td>{{ impulsador.email }}</td>
            <td>{{ nombreLegiblePlaza(impulsador.plaza_nombre || impulsador.plaza_base || impulsador.plaza) }}</td>
            <td>{{ impulsador.facturador_nombre || impulsador.facturador_codigo || '-' }}</td>
            <td><span class="scope-pill" :class="impulsador.estado === 'inhabilitado' ? 'scope-pill-user' : 'scope-pill-all'">{{ impulsador.estado || 'Sin estado' }}</span></td>
            <td>{{ nombreLider(impulsador) }}</td>
            <td>
              <span>{{ impulsador.equipo_numero ? `#${impulsador.equipo_numero} - ${impulsador.equipo_nombre || 'Equipo'}` : '-' }}</span>
              <span v-if="impulsador.organizacion_pendiente" class="scope-pill scope-pill-user">Organización pendiente</span>
            </td>
            <td><span v-if="impulsador.plaza_temporal_activa" class="scope-pill scope-pill-user">{{ impulsador.plaza_efectiva }}</span><span v-else>-</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
