const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function esUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

export function expresionAlcanceLider(userIds, liderId) {
  if (!esUuid(liderId)) return ''
  const historico = `lider_id_registro.eq.${liderId}`
  const integrantes = [...new Set((userIds ?? []).filter(esUuid))]
  if (!integrantes.length) return historico
  return `${historico},and(lider_id_registro.is.null,usuario_id.in.(${integrantes.join(',')}))`
}

export function aplicarAlcanceLider(query, alcance) {
  if (!alcance) return query
  const expresion = expresionAlcanceLider(alcance.userIds, alcance.liderId)
  if (!expresion) return null
  return query.or(expresion)
}

// Administrador y banco no tienen alcance: devuelve { alcance: null }.
export async function resolverAlcanceLider(adminSupabase, portalUser) {
  if (portalUser?.rol !== 'lider') return { alcance: null, error: null }
  const { data, error } = await adminSupabase.from('activadores').select('usuario_id').eq('lider_id', portalUser.usuario_id)
  if (error) return { alcance: null, error }
  return { alcance: { userIds: (data ?? []).map((item) => item.usuario_id), liderId: portalUser.usuario_id }, error: null }
}
