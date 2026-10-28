import ExcelJS from 'exceljs'
import { neutralizeExportRow } from './exportSafety.js'
import { aplicarAlcanceLider } from './alcanceLider.js'
import { resolveStorageObjectPathFromFotoUrl } from './storagePaths.js'
import { etiquetaCiudadActivacion, normalizarPlazaClave } from '../src/lib/plazas.js'

const PAGE_SIZE = 1000
const boliviaDateTimeFormatter = new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'America/La_Paz',
})

function yesNo(value) {
  return value == null ? '' : value ? 'Si' : 'No'
}

function formatCreatedAt(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : boliviaDateTimeFormatter.format(date)
}

function applyFilters(query, filters) {
  if (filters.fechaDesde) query = query.gte('fecha_activacion', filters.fechaDesde)
  if (filters.fechaHasta) query = query.lte('fecha_activacion', filters.fechaHasta)
  return query
}

function matchesTextFilters(row, filters) {
  const includes = (value, search) =>
    !search ||
    String(value ?? '')
      .toLocaleLowerCase('es')
      .includes(search.toLocaleLowerCase('es'))
  const mismaCiudad = (value, search) => !search || normalizarPlazaClave(value).includes(normalizarPlazaClave(search))
  return (
    includes(row.impulsador, filters.impulsador) &&
    includes(row.zona_activacion, filters.distrito) &&
    mismaCiudad(etiquetaCiudadActivacion(row), filters.plaza)
  )
}

export async function fetchActivaciones(adminSupabase, filters, alcance) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = adminSupabase.from('activaciones').select('*').order('created_at', { ascending: false })
    query = applyFilters(query, filters)
    if (alcance) {
      const acotado = aplicarAlcanceLider(query, alcance)
      if (!acotado) return rows
      query = acotado
    }
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = data ?? []
    rows.push(...page.filter((row) => matchesTextFilters(row, filters)))
    if (page.length < PAGE_SIZE) return rows
  }
}

function resolveEvidenceLinks(rows, bucket, buildEvidenceUrl) {
  const links = new Map()
  if (typeof buildEvidenceUrl !== 'function') return links

  for (const row of rows) {
    if (!row?.id) continue
    const principalPath = resolveStorageObjectPathFromFotoUrl(row.foto_url, bucket)
    if (principalPath) {
      const url = buildEvidenceUrl(row.id, 'principal', principalPath)
      if (url) links.set(`${row.id}|principal`, url)
    }
    const cashInPath = resolveStorageObjectPathFromFotoUrl(row.foto_cash_in, bucket)
    if (cashInPath) {
      const url = buildEvidenceUrl(row.id, 'cash-in', cashInPath)
      if (url) links.set(`${row.id}|cash-in`, url)
    }
  }
  return links
}

function photoHyperlink(url) {
  return url ? { text: 'Ver imagen', hyperlink: url } : null
}

export async function generateActivacionesExcel({ adminSupabase, bucket, filters, alcance, buildEvidenceUrl }) {
  const rows = await fetchActivaciones(adminSupabase, filters, alcance)
  const evidenceLinks = resolveEvidenceLinks(rows, bucket, buildEvidenceUrl)
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Activaciones', { views: [{ state: 'frozen', ySplit: 2 }] })
  worksheet.columns = [
    ['#', 'numero', 7],
    ['Creado', 'creado', 26],
    ['Fecha', 'fecha', 14],
    ['Impulsador', 'impulsador', 24],
    ['Ciudad', 'ciudad', 18],
    ['Distrito', 'distrito', 20],
    ['Plaza Base', 'plazaBase', 18],
    ['Plaza Efectiva', 'plazaEfectiva', 20],
    ['Equipo', 'equipo', 20],
    ['Facturador', 'facturador', 22],
    ['Lider vigente', 'liderVigente', 24],
    ['Nombres Cliente', 'nombres', 24],
    ['Apellidos Cliente', 'apellidos', 24],
    ['CI Cliente', 'ci', 14],
    ['Telefono Cliente', 'telefono', 16],
    ['Email Cliente', 'email', 28],
    ['Descargo App', 'descargo', 14],
    ['Registro', 'registro', 12],
    ['Cash In', 'cashIn', 10],
    ['Cash Out', 'cashOut', 10],
    ['P2P', 'p2p', 10],
    ['QR Fisico', 'qrFisico', 12],
    ['Respaldo', 'respaldo', 11],
    ['Hubo Error', 'huboError', 12],
    ['Descripcion Error', 'descripcionError', 30],
    ['Tipo Activacion', 'tipoActivacion', 20],
    ['Tipo Comercio', 'tipoComercio', 20],
    ['Tamano Tienda', 'tamanoTienda', 18],
    ['Tipo Tienda', 'tipoTienda', 18],
    ['Rubro Comercio', 'rubroComercio', 20],
    ['Otro Rubro', 'otroRubro', 20],
    ['Fuera de Mercado', 'fueraMercado', 18],
    ['Tipo Error', 'tipoError', 20],
    ['Observaciones', 'observaciones', 30],
    ['Es Plaza Temporal', 'esPlazaTemporal', 18],
    ['Plaza Temporal', 'plazaTemporal', 20],
    ['Foto', 'foto', 28],
    ['Foto Cash-In', 'fotoCashIn', 28],
    ['Latitud', 'latitud', 14],
    ['Longitud', 'longitud', 14],
    ['Usuario ID', 'usuarioId', 38],
    ['Creditos', 'creditos', 12],
    ['Remesas', 'remesas', 12],
  ].map(([header, key, width]) => ({ header, key, width }))

  worksheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF101E2E' } }
  })
  worksheet.insertRow(1, ['Exportación con enlaces v2'])
  worksheet.mergeCells(1, 1, 1, worksheet.columnCount)
  const versionCell = worksheet.getCell('A1')
  versionCell.font = { bold: true, color: { argb: 'FF0563C1' } }
  versionCell.alignment = { horizontal: 'center' }

  rows.forEach((row, index) =>
    worksheet.addRow(
      neutralizeExportRow({
        numero: index + 1,
        creado: formatCreatedAt(row.created_at),
        fecha: row.fecha_activacion,
        impulsador: row.impulsador,
        ciudad: etiquetaCiudadActivacion(row),
        distrito: row.zona_activacion,
        plazaBase: row.plaza_base_registro ?? '',
        plazaEfectiva: row.plaza_efectiva_registro ?? '',
        equipo: row.equipo_nombre_registro || (row.equipo_numero_registro ? `Equipo #${row.equipo_numero_registro}` : ''),
        facturador: row.facturador_nombre_registro,
        liderVigente: row.lider_nombre_registro,
        nombres: row.nombres_cliente,
        apellidos: row.apellidos_cliente,
        ci: row.ci_cliente,
        telefono: row.telefono_cliente,
        email: row.email_cliente,
        descargo: yesNo(row.descargo_app),
        registro: yesNo(row.registro),
        cashIn: yesNo(row.cash_in),
        cashOut: yesNo(row.cash_out),
        p2p: yesNo(row.p2p),
        qrFisico: yesNo(row.qr_fisico),
        respaldo: yesNo(row.respaldo),
        huboError: yesNo(row.hubo_error),
        descripcionError: row.descripcion_error,
        tipoActivacion: row.tipo_activacion,
        tipoComercio: row.tipo_comercio,
        tamanoTienda: row.tamano_tienda,
        tipoTienda: row.tipo_tienda,
        rubroComercio: row.rubro_comercio,
        otroRubro: row.rubro_comercio_otro,
        fueraMercado: yesNo(row.comercio_fuera_mercado),
        tipoError: row.tipo_error,
        observaciones: row.observaciones,
        esPlazaTemporal: yesNo(row.es_plaza_temporal),
        plazaTemporal: row.plaza_temporal,
        foto: photoHyperlink(evidenceLinks.get(`${row.id}|principal`)),
        fotoCashIn: photoHyperlink(evidenceLinks.get(`${row.id}|cash-in`)),
        latitud: row.latitud,
        longitud: row.longitud,
        usuarioId: row.usuario_id,
        creditos: row.creditos ? 'Si' : 'No',
        remesas: row.remesas ? 'Si' : 'No',
      }),
    ),
  )

  for (const key of ['foto', 'fotoCashIn']) {
    worksheet.getColumn(key).eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      if (rowNumber > 2 && cell.value?.hyperlink) {
        cell.font = { color: { argb: 'FF0563C1' }, underline: true }
      }
    })
  }

  return { buffer: await workbook.xlsx.writeBuffer(), rowCount: rows.length }
}
