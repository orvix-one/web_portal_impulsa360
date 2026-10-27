// Columnas del listado paginado. Los candidatos opcionales (nombre comercial,
// resultado...) no estan confirmados en el esquema remoto, asi que se
// intersectan con las columnas reales de una fila antes de usarlas en select().
const BASE = [
  'id',
  'usuario_id',
  'created_at',
  'fecha_activacion',
  'impulsador',
  'nombres_cliente',
  'apellidos_cliente',
  'tipo_activacion',
  'ciudad_activacion',
  'zona_activacion',
  'hubo_error',
]
const OPCIONALES = ['nombre_comercio', 'comercio', 'cliente', 'resultado', 'estado']

export function columnasListado(columnasDisponibles) {
  if (!columnasDisponibles) return BASE
  return [...BASE, ...OPCIONALES.filter((columna) => columnasDisponibles.has(columna))]
}

export function crearResolutorColumnasListado(adminSupabase) {
  let columnas = null
  let pendiente = null
  return async function resolverColumnas() {
    if (columnas) return columnas.join(',')
    pendiente ??= adminSupabase
      .from('activaciones')
      .select('*')
      .limit(1)
      .then(({ data, error }) => {
        if (error) throw error
        // Sin filas no se puede descubrir el esquema: solo BASE, sin cachear.
        const fila = data?.[0]
        if (!fila) return columnasListado(null)
        columnas = columnasListado(new Set(Object.keys(fila)))
        return columnas
      })
      .finally(() => {
        pendiente = null
      })
    return (await pendiente).join(',')
  }
}

export function parsearPagina(query = {}, { maxPageSize = 100, defaultPageSize = 50 } = {}) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1)
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.parseInt(String(query.pageSize ?? defaultPageSize), 10) || defaultPageSize))
  return { page, pageSize }
}
