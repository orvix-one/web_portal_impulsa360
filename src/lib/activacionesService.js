import { supabase } from './supabaseClient'

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')

export async function portalRequest(path) {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Sesion requerida.')
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${data.session.access_token}` } })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `Error HTTP ${response.status}`)
  return payload
}

export async function fetchMetricasActivaciones() {
  const payload = await portalRequest('/portal/metrics/activations')
  return payload.activations ?? []
}

const CLAVES_FILTRO = ['plaza', 'distrito', 'impulsador', 'fechaDesde', 'fechaHasta']

function filtrosAQuery(filtros = {}) {
  const params = new URLSearchParams()
  for (const clave of CLAVES_FILTRO) if (filtros[clave]) params.set(clave, filtros[clave])
  return params
}

export async function fetchActivacionesPagina({ page = 1, pageSize = 50, filtros } = {}) {
  const params = filtrosAQuery(filtros)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const payload = await portalRequest(`/portal/activations/page?${params}`)
  return { activations: payload.activations ?? [], total: payload.total ?? 0 }
}

export async function fetchActivacionDetalle(id) {
  const payload = await portalRequest(`/portal/activations/${encodeURIComponent(id)}`)
  return payload.activation
}

export async function fetchActivacionesExportacion(filtros) {
  const payload = await portalRequest(`/portal/activations/export-rows?${filtrosAQuery(filtros)}`)
  return payload.activations ?? []
}
