import { supabase } from './supabaseClient'
import { AUTH_ENABLED } from './featureFlags'

const apiBaseUrl = (import.meta.env.VITE_ADMIN_API_URL ?? '/api').replace(/\/$/, '')

export async function portalRequest(path) {
  const { data } = await supabase.auth.getSession()
  if (!data.session?.access_token) throw new Error('Sesion requerida.')
  const response = await fetch(`${apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${data.session.access_token}` } })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `Error HTTP ${response.status}`)
  return payload
}

export async function fetchAllActivaciones() {
  const rows = []
  for (let from = 0; ; from += 1000) {
    let page
    if (AUTH_ENABLED) {
      const payload = await portalRequest(`/portal/activations?from=${from}&to=${from + 999}`)
      page = payload.activations ?? []
    } else {
      const { data, error } = await supabase.from('activaciones').select('*').order('created_at', { ascending: false }).range(from, from + 999)
      if (error) throw error
      page = data ?? []
    }
    rows.push(...page)
    if (page.length < 1000) return rows
  }
}

const CLAVES_FILTRO = ['plaza', 'distrito', 'impulsador', 'fechaDesde', 'fechaHasta']

function filtrosAQuery(filtros = {}) {
  const params = new URLSearchParams()
  for (const clave of CLAVES_FILTRO) if (filtros[clave]) params.set(clave, filtros[clave])
  return params
}

// Una pagina del listado (columnas livianas, filtros aplicados en el servidor).
export async function fetchActivacionesPagina({ page = 1, pageSize = 50, filtros } = {}) {
  const params = filtrosAQuery(filtros)
  params.set('page', String(page))
  params.set('pageSize', String(pageSize))
  const payload = await portalRequest(`/portal/activations/page?${params}`)
  return { activations: payload.activations ?? [], total: payload.total ?? 0 }
}

// Fila completa con correo del activador y fotos firmadas.
export async function fetchActivacionDetalle(id) {
  const payload = await portalRequest(`/portal/activations/${encodeURIComponent(id)}`)
  return payload.activation
}

// Todas las filas del corte filtrado, para CSV y Excel generados en el navegador.
export async function fetchActivacionesExportacion(filtros) {
  const payload = await portalRequest(`/portal/activations/export-rows?${filtrosAQuery(filtros)}`)
  return payload.activations ?? []
}
