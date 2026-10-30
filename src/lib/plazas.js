const PLAZA_CANONICAS = new Map([
  ['lapaz', 'La Paz'],
  ['elalto', 'El Alto'],
  ['santacruz', 'Santa Cruz de la Sierra'],
  ['santacruzdelasierra', 'Santa Cruz de la Sierra'],
  ['cochabamba', 'Cochabamba'],
  ['oruro', 'Oruro'],
  ['potosi', 'Potosi'],
  ['tarija', 'Tarija'],
  ['chuquisaca', 'Chuquisaca'],
  ['sucre', 'Sucre'],
  ['beni', 'Beni'],
  ['trinidad', 'Trinidad'],
  ['pando', 'Pando'],
  ['cobija', 'Cobija'],
])

export const SIN_CIUDAD_REGISTRADA = 'Sin ciudad registrada'

export function ciudadActivacion(fila) {
  const crudo = typeof fila === 'string' ? fila : fila?.ciudad_activacion
  const clave = normalizarPlazaClave(crudo)
  if (!clave) return ''
  return PLAZA_CANONICAS.get(clave) ?? titleCase(crudo)
}

export function etiquetaCiudadActivacion(fila) {
  return ciudadActivacion(fila) || SIN_CIUDAD_REGISTRADA
}

export function normalizarPlazaClave(value) {
  return String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/g, '')
}

function titleCase(value) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLocaleLowerCase('es')
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('es'))
}

export function nombreLegiblePlaza(value) {
  const key = normalizarPlazaClave(value)
  return PLAZA_CANONICAS.get(key) ?? titleCase(value)
}

export function mismaPlaza(a, b) {
  return normalizarPlazaClave(a) === normalizarPlazaClave(b)
}

export function parsearAliasesPlaza(value) {
  const crudos = Array.isArray(value) ? value : String(value ?? '').split(',')
  const aliases = new Map()
  for (const crudo of crudos) {
    const alias = typeof crudo === 'string' ? crudo.trim() : ''
    const clave = normalizarPlazaClave(alias)
    if (clave && !aliases.has(clave)) aliases.set(clave, alias)
  }
  return [...aliases.values()]
}

export function deduplicarPlazas(values) {
  const map = new Map()
  for (const value of values) {
    if (!value) continue
    const nombre = nombreLegiblePlaza(value)
    const key = normalizarPlazaClave(nombre)
    if (!key || map.has(key)) continue
    map.set(key, { key, value, nombre })
  }
  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}

export function deduplicarPlazasCatalogo(plazas) {
  const byKey = new Map()
  for (const plaza of plazas ?? []) {
    if (!plaza?.id && !plaza?.nombre) continue
    const sourceName = plaza.nombre_normalizado || plaza.codigo || plaza.nombre || plaza.id
    const nombre = nombreLegiblePlaza(plaza.nombre || sourceName)
    const key = normalizarPlazaClave(nombre)
    if (!key) continue
    const item = { ...plaza, nombre }
    const current = byKey.get(key)
    const currentRaw = String(current?.nombre ?? '')
    const itemRaw = String(plaza.nombre ?? '')
    const itemLooksCanonical = itemRaw && !/[_-]/.test(itemRaw)
    const currentLooksCanonical = currentRaw && !/[_-]/.test(currentRaw)
    if (!current || (item.activa && !current.activa) || (itemLooksCanonical && !currentLooksCanonical)) {
      byKey.set(key, item)
    }
  }
  return [...byKey.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}
