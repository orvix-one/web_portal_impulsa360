// Carga de activaciones para Metricas: proyeccion liviana leida en paginas paralelas.

export const SELECT_METRICAS_ACTIVACIONES = [
  'id',
  'usuario_id',
  'fecha_activacion',
  'created_at',
  'ciudad_activacion',
  'impulsador',
  'tipo_activacion',
  'nombres_cliente',
  'hubo_error',
  'tipo_comercio',
  'tipo_tienda',
  'lider_id_registro',
  'lider_nombre_registro',
  'equipo_id_registro',
  'equipo_numero_registro',
  'equipo_nombre_registro',
  'cash_in',
  'latitud',
  'longitud',
].join(',')

// Limita las peticiones simultaneas para no saturar el pool de PostgREST (Nano).
export async function ejecutarConConcurrencia(tareas, limite) {
  const resultados = new Array(tareas.length)
  let siguiente = 0
  async function trabajador() {
    while (siguiente < tareas.length) {
      const indice = siguiente
      siguiente += 1
      resultados[indice] = await tareas[indice]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, trabajador))
  return resultados
}

// construirConsulta devuelve null cuando el alcance no autoriza nada.
export async function cargarActivacionesMetricas({ construirConsulta, pageSize = 1000, concurrencia = 4 }) {
  const pagina = (indice, options) =>
    construirConsulta(SELECT_METRICAS_ACTIVACIONES, options)
      ?.order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(indice * pageSize, indice * pageSize + pageSize - 1)

  const primera = pagina(0, { count: 'exact' })
  if (!primera) return []
  const { data, count, error } = await primera
  if (error) throw error
  const filas = [...(data ?? [])]

  const paginas = Math.ceil((count ?? filas.length) / pageSize)
  const restantes = Array.from({ length: Math.max(0, paginas - 1) }, (_, i) => async () => {
    const respuesta = await pagina(i + 1)
    // Filas borradas tras el conteo pueden dejar la pagina fuera de rango.
    if (respuesta.error?.code === 'PGRST103') return []
    if (respuesta.error) throw respuesta.error
    return respuesta.data ?? []
  })
  for (const filasPagina of await ejecutarConConcurrencia(restantes, concurrencia)) filas.push(...filasPagina)

  // Una insercion entre paginas desplaza el OFFSET y repite una fila.
  const vistas = new Set()
  return filas.filter((fila) => !vistas.has(fila.id) && vistas.add(fila.id))
}
