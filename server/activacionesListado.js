export const SELECT_LISTADO_ACTIVACIONES = [
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
].join(',')

export function parsearPagina(query = {}, { maxPageSize = 100, defaultPageSize = 50 } = {}) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1)
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.parseInt(String(query.pageSize ?? defaultPageSize), 10) || defaultPageSize))
  return { page, pageSize }
}
