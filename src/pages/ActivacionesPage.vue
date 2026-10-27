<script setup>
import { onMounted, ref } from 'vue'
import ActivacionesTable from '../components/ActivacionesTable.vue'
import { fetchActivacionesPagina } from '../lib/activacionesService'
import { logClientError } from '../lib/logging'

const PAGE_SIZE = 50

const activaciones = ref([])
const total = ref(0)
const page = ref(1)
const filtros = ref({})
const loading = ref(true)
const errorMsg = ref(null)
let solicitud = 0

// silencioso: refresca la pagina actual (tras editar o borrar) sin parpadeo.
async function cargar({ silencioso = false } = {}) {
  const actual = ++solicitud
  if (!silencioso) loading.value = true
  errorMsg.value = null

  try {
    const resultado = await fetchActivacionesPagina({ page: page.value, pageSize: PAGE_SIZE, filtros: filtros.value })
    if (actual !== solicitud) return
    activaciones.value = resultado.activations
    total.value = resultado.total
    // Tras borrar el ultimo registro de la ultima pagina, volver a la ultima pagina valida.
    if (!resultado.activations.length && resultado.total > 0 && page.value > 1) {
      page.value = Math.ceil(resultado.total / PAGE_SIZE)
      await cargar({ silencioso })
    }
  } catch (error) {
    if (actual !== solicitud) return
    logClientError('activaciones.fetch', error)
    errorMsg.value = 'Error al obtener activaciones.'
  } finally {
    if (actual === solicitud) loading.value = false
  }
}

function onFiltrar(nuevosFiltros) {
  filtros.value = nuevosFiltros
  page.value = 1
  cargar()
}

function onCambiarPagina(nuevaPagina) {
  page.value = nuevaPagina
  cargar()
}

onMounted(cargar)
</script>

<template>
  <section class="view-page">
    <header class="view-header">
      <p class="view-kicker">Field Command</p>
      <h1 class="view-title">Control de Activaciones</h1>
      <p class="view-description">Monitorea registros en tiempo real, filtra por plaza e impulsador y exporta cortes operativos.</p>
      <div class="meta-row">
        <span class="meta-pill">
          {{ loading ? 'Sincronizando...' : `${total} registros` }}
        </span>
      </div>
    </header>

    <div class="panel-card">
      <p v-if="errorMsg" class="mensaje-error">{{ errorMsg }}</p>
      <ActivacionesTable
        :activaciones="activaciones"
        :total="total"
        :page="page"
        :page-size="PAGE_SIZE"
        :loading="loading"
        @filtrar="onFiltrar"
        @cambiar-pagina="onCambiarPagina"
        @activacion-eliminada="cargar({ silencioso: true })"
        @activacion-actualizada="cargar({ silencioso: true })"
      />
    </div>
  </section>
</template>
