import { etiquetaCiudadActivacion, normalizarPlazaClave, SIN_CIUDAD_REGISTRADA } from '../src/lib/plazas.js'

// Filtros del listado de activaciones aplicados en SQL, con la semantica que tenia el navegador.
const FECHA = /^(\d{4}-\d{2}-\d{2})/

function soloFecha(value) {
  return (
    String(value ?? '')
      .trim()
      .match(FECHA)?.[1] ?? ''
  )
}

function texto(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizarFiltros(raw = {}) {
  let fechaDesde = soloFecha(raw.fechaDesde)
  let fechaHasta = soloFecha(raw.fechaHasta)
  if (fechaDesde && fechaHasta && fechaDesde > fechaHasta) [fechaDesde, fechaHasta] = [fechaHasta, fechaDesde]
  return {
    plaza: texto(raw.plaza),
    distrito: texto(raw.distrito),
    impulsador: texto(raw.impulsador),
    fechaDesde,
    fechaHasta,
  }
}

export function escaparLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function ciudadesQueCoinciden(valoresCrudos, consulta) {
  const clave = normalizarPlazaClave(consulta)
  if (!clave) return null
  const incluirSinCiudad = normalizarPlazaClave(SIN_CIUDAD_REGISTRADA).includes(clave)
  const valores = new Set()
  for (const crudo of valoresCrudos) {
    if (crudo == null) continue
    if (!normalizarPlazaClave(crudo)) {
      if (incluirSinCiudad) valores.add(crudo)
      continue
    }
    if (normalizarPlazaClave(etiquetaCiudadActivacion({ ciudad_activacion: crudo })).includes(clave)) valores.add(crudo)
  }
  return { valores: [...valores], incluirNulos: incluirSinCiudad }
}

function aplicarCiudades(query, { valores, incluirNulos }) {
  if (!valores.length && !incluirNulos) return null
  if (!incluirNulos) return query.in('ciudad_activacion', valores)
  const lista = valores.map((valor) => `"${valor.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')
  return query.or(`ciudad_activacion.is.null${lista ? `,ciudad_activacion.in.(${lista})` : ''}`)
}

// Devuelve null cuando ningun registro puede coincidir.
export function aplicarFiltrosActivaciones(query, filtros, ciudades = null) {
  if (filtros.fechaDesde) query = query.gte('fecha_activacion', filtros.fechaDesde)
  if (filtros.fechaHasta) query = query.lte('fecha_activacion', filtros.fechaHasta)
  if (filtros.distrito) query = query.ilike('zona_activacion', `%${escaparLike(filtros.distrito)}%`)
  if (filtros.impulsador) query = query.ilike('impulsador', `%${escaparLike(filtros.impulsador)}%`)
  if (ciudades) return aplicarCiudades(query, ciudades)
  return query
}

export function crearCatalogoCiudades(adminSupabase, { ttlMs = 5 * 60 * 1000, now = Date.now } = {}) {
  let cache = null
  let pendiente = null

  async function cargar() {
    const valores = new Set()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await adminSupabase
        .from('activaciones')
        .select('ciudad_activacion')
        .order('id', { ascending: true })
        .range(from, from + 999)
      if (error) throw error
      for (const fila of data ?? []) valores.add(fila.ciudad_activacion ?? null)
      if ((data ?? []).length < 1000) break
    }
    return [...valores]
  }

  return async function obtenerCiudades() {
    if (cache && now() - cache.at < ttlMs) return cache.valores
    pendiente ??= cargar()
      .then((valores) => {
        cache = { valores, at: now() }
        return valores
      })
      .finally(() => {
        pendiente = null
      })
    return pendiente
  }
}

export async function resolverCiudadesFiltro(obtenerCiudades, filtros) {
  if (!filtros.plaza) return null
  return ciudadesQueCoinciden(await obtenerCiudades(), filtros.plaza) ?? null
}
