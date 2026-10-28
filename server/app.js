import crypto from 'node:crypto'
import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { fetchActivaciones, generateActivacionesExcel } from './activacionesExcel.js'
import { aplicarAlcanceLider, esUuid, resolverAlcanceLider } from './alcanceLider.js'
import { aplicarFiltrosActivaciones, crearCatalogoCiudades, normalizarFiltros, resolverCiudadesFiltro } from './activacionesFiltros.js'
import { SELECT_LISTADO_ACTIVACIONES, parsearPagina } from './activacionesListado.js'
import { cargarActivacionesMetricas } from './metricasActivaciones.js'
import { serverTimingMiddleware } from './serverTiming.js'
import {
  activationClassificationUpdate,
  isCreditosEligible,
  isRemesasEligible,
  normalizeActivationClassification,
  validateActivationClassification,
  validateActivationTextLengths,
} from '../src/lib/activationEditing.js'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ACTIVATION_EDITABLE_FIELDS = new Set([
  'nombres_cliente',
  'apellidos_cliente',
  'ci_cliente',
  'nombre_comercio',
  'comercio',
  'cliente',
  'telefono_cliente',
  'email_cliente',
  'plaza',
  'ciudad_activacion',
  'tipo_activacion',
  'resultado',
  'estado',
  'tipo_tienda',
  'tamano_tienda',
  'tipo_comercio',
  'rubro_comercio',
  'rubro_comercio_otro',
  'comercio_fuera_mercado',
  'observaciones',
  'tipo_error',
  'descripcion_error',
  'descargo_app',
  'registro',
  'cash_in',
  'cash_out',
  'p2p',
  'qr_fisico',
  'respaldo',
  'creditos',
  'remesas',
  'hubo_error',
  'es_plaza_temporal',
  'plaza_temporal',
])
const ALLOWED_STORE_SIZES = new Set(['Pequeña', 'Mediana', 'Grande'])
const ALLOWED_USER_ROLES = new Set(['activador', 'lider', 'facturador', 'administrador', 'banco'])
const USER_ROLE_PRIORITY = ['administrador', 'lider', 'banco', 'facturador', 'activador']

function resolveUserRoles(body, previousRoles = [], previousRol = null) {
  const explicitRoles = Object.prototype.hasOwnProperty.call(body ?? {}, 'roles')
  const requestedRol = normalizeText(body?.rol)
  if (requestedRol && !ALLOWED_USER_ROLES.has(requestedRol)) throw new Error('rol invalido.')
  if (explicitRoles && (!Array.isArray(body.roles) || !body.roles.length ||
    body.roles.some((rol) => typeof rol !== 'string' || !ALLOWED_USER_ROLES.has(rol)))) {
    throw new Error('roles debe contener al menos un rol valido.')
  }
  const roles = explicitRoles ? [...new Set(body.roles)] : [...new Set([
    ...(previousRoles.length ? previousRoles : previousRol ? [previousRol] : [])
      .filter((rol) => !requestedRol || requestedRol === previousRol || rol !== previousRol),
    ...(requestedRol ? [requestedRol] : []),
  ])]
  if (!roles.length) roles.push('activador')
  if (requestedRol && !roles.includes(requestedRol)) throw new Error('rol debe pertenecer a roles.')
  return { roles, rol: requestedRol || (roles.includes(previousRol) ? previousRol : USER_ROLE_PRIORITY.find((rol) => roles.includes(rol))) }
}
const ALLOWED_USER_STATES = new Set(['activo', 'inhabilitado'])
const ALLOWED_TEMPORARY_ZONE_TYPES = new Set(['universidad', 'feria', 'evento', 'campana', 'punto_temporal'])
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_BASIC_USER',
  'ADMIN_BASIC_PASS',
  'EVIDENCE_LINK_SECRET',
]
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  /* Bloque desplazado accidentalmente; se conserva comentado hasta retirarlo del diff.
    try {
      // Realizar conteos separados por tabla/columna
      const equiposRes = await adminSupabase.from('equipos').select('id', { count: 'exact', head: true }).eq('plaza_id', plazaId)
      const activadoresPlazaIdRes = await adminSupabase.from('activadores').select('usuario_id', { count: 'exact', head: true }).eq('plaza_id', plazaId)
      const activadoresPlazaBaseRes = await adminSupabase.from('activadores').select('plaza_base', { count: 'exact', head: true }).eq('plaza_base', plazaId)
      const activacionesPlazaIdRes = await adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_id_registro', plazaId)
      const activacionesPlazaBaseIdRes = await adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_base_id_registro', plazaId)
      const activacionesPlazaEfectivaIdRes = await adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_efectiva_id_registro', plazaId)
      const temporalesRes = await adminSupabase.from('activador_plaza_temporal').select('id', { count: 'exact', head: true }).eq('plaza_temporal_id', plazaId)

      const relations = []

      if (equiposRes.error) relations.push({ table: 'equipos', column: 'plaza_id', error: true })
      else if ((equiposRes.count ?? 0) > 0) relations.push({ table: 'equipos', column: 'plaza_id', count: equiposRes.count ?? 0 })

      if (activadoresPlazaIdRes.error) relations.push({ table: 'activadores', column: 'plaza_id', error: true })
      else if ((activadoresPlazaIdRes.count ?? 0) > 0) relations.push({ table: 'activadores', column: 'plaza_id', count: activadoresPlazaIdRes.count ?? 0 })

      // Detectar si plaza_base almacena UUID o texto sin exponer datos
      let plazaBaseType = 'unknown'
      try {
        const sampleValues = await adminSupabase.from('activadores').select('plaza_base').not('plaza_base', 'is', null).limit(10)
        const values = (sampleValues.data ?? []).map((r) => r.plaza_base).filter(Boolean)
        const uuidLike = values.some((v) => typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v))
        plazaBaseType = uuidLike ? 'uuid' : 'text'
      } catch (_e) {
        plazaBaseType = 'unknown'
      }

      if (activadoresPlazaBaseRes.error) relations.push({ table: 'activadores', column: 'plaza_base', error: true })
      else if (plazaBaseType === 'uuid') {
        if ((activadoresPlazaBaseRes.count ?? 0) > 0) relations.push({ table: 'activadores', column: 'plaza_base', count: activadoresPlazaBaseRes.count ?? 0 })
      } else if (plazaBaseType === 'text') {
        // Si plaza_base es texto, no tratarla como FK a plaza.id; omitir la relación
      } else {
        // tipo desconocido: conservadormente marcar como posible error
        if ((activadoresPlazaBaseRes.count ?? 0) > 0) relations.push({ table: 'activadores', column: 'plaza_base', error: true })
      }

      if (activacionesPlazaIdRes.error) relations.push({ table: 'activaciones', column: 'plaza_id_registro', error: true })
      else if ((activacionesPlazaIdRes.count ?? 0) > 0) relations.push({ table: 'activaciones', column: 'plaza_id_registro', count: activacionesPlazaIdRes.count ?? 0 })

      if (activacionesPlazaBaseIdRes.error) relations.push({ table: 'activaciones', column: 'plaza_base_id_registro', error: true })
      else if ((activacionesPlazaBaseIdRes.count ?? 0) > 0) relations.push({ table: 'activaciones', column: 'plaza_base_id_registro', count: activacionesPlazaBaseIdRes.count ?? 0 })

      if (activacionesPlazaEfectivaIdRes.error) relations.push({ table: 'activaciones', column: 'plaza_efectiva_id_registro', error: true })
      else if ((activacionesPlazaEfectivaIdRes.count ?? 0) > 0) relations.push({ table: 'activaciones', column: 'plaza_efectiva_id_registro', count: activacionesPlazaEfectivaIdRes.count ?? 0 })

      if (temporalesRes.error) relations.push({ table: 'activador_plaza_temporal', column: 'plaza_temporal_id', error: true })
      else if ((temporalesRes.count ?? 0) > 0) relations.push({ table: 'activador_plaza_temporal', column: 'plaza_temporal_id', count: temporalesRes.count ?? 0 })

      if (relations.length > 0) {
        res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar la plaza porque tiene información relacionada.', relations })
        return
      }

      // No se encontraron relaciones: permitir eliminación física
      const { error: delErr } = await adminSupabase.from('plazas').delete().eq('id', plazaId)
      if (delErr) { jsonError(res, 500, 'No se pudo eliminar la plaza.', delErr.message); return }
      res.json({ ok: true, deleted: true, message: 'Plaza eliminada correctamente.' })
    } catch (err) {
      jsonError(res, 500, 'Error verificando relaciones de plaza.', err?.message ?? String(err))
    }
  }

  */
]
const ADMIN_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 1000,
  maxRequests: 20,
})
const REQUEST_BODY_LIMIT = '1mb'
const ACTIVATION_PHOTO_MAX_BYTES = 10 * 1024 * 1024
const EVIDENCE_LINK_TYPES = Object.freeze({ principal: 'foto_url', 'cash-in': 'foto_cash_in' })
const EVIDENCE_LINK_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const EVIDENCE_LINK_SIGNED_TTL_SECONDS = 300
const EVIDENCE_LINK_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 1000,
  maxRequests: 60,
})

export function buildEvidenceToken(secret, activacionId, tipo, objectPath) {
  return crypto.createHmac('sha256', String(secret))
    .update(`${activacionId}|${tipo}|${objectPath}`, 'utf8')
    .digest('hex')
}

export function buildEvidencePath(activacionId, tipo, token) {
  return `/evidencia/${activacionId}/${tipo}/${token}`
}

export function verifyEvidenceToken(secret, activacionId, tipo, objectPath, token) {
  if (!EVIDENCE_LINK_TOKEN_PATTERN.test(String(token ?? ''))) {
    return false
  }

  return timingSafeEqualText(String(token), buildEvidenceToken(secret, activacionId, tipo, objectPath))
}

function resolveEvidencePublicBaseUrl(rawValue) {
  const normalized = normalizeText(rawValue).replace(/\/+$/, '')

  if (!/^https?:\/\/[^/]+/i.test(normalized)) {
    return null
  }

  if (normalized.toLowerCase().startsWith('http://')) {
    let hostname = ''

    try {
      hostname = new URL(normalized).hostname.toLowerCase()
    } catch {
      return null
    }

    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return null
    }
  }

  return normalized
}
const ACTIVATION_PHOTO_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
})
const MB = 1024 * 1024
const GB = 1024 * MB
const SUPABASE_FREE_PLAN_REFERENCE = Object.freeze({
  name: 'Supabase Free',
  api_requests: 'Unlimited API requests',
  monthly_active_users_limit: 50000,
  database_limit_bytes: 500 * MB,
  shared_ram_mb: 500,
  cpu_tier: 'shared',
  egress_limit_bytes: 5 * GB,
  cached_egress_limit_bytes: 5 * GB,
  file_storage_limit_bytes: 1 * GB,
  support: 'Community support',
})
const INTERNAL_TEAM_NAME = 'Equipo administrativo'

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value)
  return normalized || null
}

function normalizeOrganizationName(value) {
  return normalizeText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase()
}

function isValidEmail(value) {
  return EMAIL_REGEX.test(normalizeEmail(value))
}

function isStrongPassword(value) {
  return typeof value === 'string' && value.length >= 10 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)
}

function isMissingOrganizationSchema(error) {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '').toLowerCase()
  return ['42P01', 'PGRST200', 'PGRST202', 'PGRST204', 'PGRST205'].includes(code) ||
    message.includes('schema cache') || message.includes('does not exist') || message.includes('could not find the table')
}

export function resolvePort(rawValue) {
  const parsedPort = Number(rawValue ?? 8787)
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    return 8787
  }
  return parsedPort
}

function assertRequiredEnv(env) {
  for (const envName of REQUIRED_ENV) {
    if (!env[envName]) {
      throw new Error(`Falta variable de entorno requerida: ${envName}`)
    }
  }
}

function buildAllowedOrigins(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return DEFAULT_ALLOWED_ORIGINS
  }

  return rawValue
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildOriginMatcher(pattern) {
  if (pattern === '*') {
    return () => true
  }

  if (!pattern.includes('*')) {
    return (origin) => origin === pattern
  }

  const regexPattern = `^${escapeRegex(pattern).replace(/\\\*/g, '.*')}$`
  const matcherRegex = new RegExp(regexPattern)
  return (origin) => matcherRegex.test(origin)
}

function headerFirstValue(value) {
  if (Array.isArray(value)) {
    return value[0] ?? ''
  }

  if (typeof value === 'string') {
    return value.split(',')[0].trim()
  }

  return ''
}

function getRequestOrigin(req) {
  const forwardedProto = headerFirstValue(req.headers['x-forwarded-proto'])
  const forwardedHost = headerFirstValue(req.headers['x-forwarded-host'])
  const host = forwardedHost || headerFirstValue(req.headers.host)

  if (!host) {
    return null
  }

  const protocol = forwardedProto || req.protocol || 'http'
  return `${protocol}://${host}`
}

function isOriginAllowed(origin, req, allowedOriginMatchers) {
  if (!origin) {
    return true
  }

  if (allowedOriginMatchers.some((matcher) => matcher(origin))) {
    return true
  }

  const requestOrigin = getRequestOrigin(req)
  return Boolean(requestOrigin && requestOrigin === origin)
}

function jsonError(res, statusCode, message, details) {
  if (details) {
    console.error('[admin-api] Detalle interno:', sanitizeLogDetails(details))
  }

  const payload = { error: statusCode >= 500 ? 'Error interno del servidor.' : message }
  if (statusCode >= 500) {
    payload.requestId = crypto.randomUUID()
  }
  res.status(statusCode).json(payload)
}

function sanitizeLogDetails(details) {
  if (!details) return null
  if (typeof details === 'string') return { message: redactSensitiveLogText(details) }
  if (details instanceof Error) {
    return {
      name: details.name,
      message: typeof details.message === 'string' ? redactSensitiveLogText(details.message) : undefined,
      code: details.code,
      status: details.status,
    }
  }
  if (typeof details === 'object') {
    return {
      name: details.name,
      message: typeof details.message === 'string' ? redactSensitiveLogText(details.message) : undefined,
      code: details.code,
      status: details.status,
    }
  }
  return { type: typeof details }
}

function redactSensitiveLogText(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{7,}\b/g, '[number]')
    .slice(0, 240)
}

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://*.supabase.co https://*.tile.openstreetmap.org",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  )

  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0].trim()
    : ''
  if (req.secure || forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  next()
}

function handleBodyParseError(error, _req, res, next) {
  if (!error) {
    next()
    return
  }

  const statusCode = error.type === 'entity.too.large' ? 413 : 400
  jsonError(
    res,
    statusCode,
    statusCode === 413 ? 'El cuerpo de la solicitud excede el limite permitido.' : 'Solicitud invalida.',
    error.message
  )
}

function parseActivationPhotoBody(req, res, next) {
  express.raw({ type: () => true, limit: ACTIVATION_PHOTO_MAX_BYTES })(req, res, (error) => {
    if (!error) {
      next()
      return
    }
    if (error?.type === 'entity.too.large') {
      jsonError(res, 413, 'La foto excede el limite de 10 MB.')
      return
    }
    jsonError(res, 400, 'No se pudo procesar la foto enviada.')
  })
}

function isValidActivationPhotoBuffer(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  return false
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      next(error)
    }
  }
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) {
    return null
  }

  try {
    const base64Payload = header.slice('Basic '.length)
    const decoded = Buffer.from(base64Payload, 'base64').toString('utf8')
    const separatorIndex = decoded.indexOf(':')

    if (separatorIndex < 0) {
      return null
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    }
  } catch {
    return null
  }
}

function createAdminRateLimiter({ windowMs, maxRequests }) {
  const attempts = new Map()

  return (req, res, next) => {
    const now = Date.now()
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    const parsed = parseBasicAuth(authorization)
    const subject = parsed
      ? `basic:${parsed.username}`
      : authorization.startsWith('Bearer ')
        ? 'bearer'
        : 'anonymous'
    const key = `${req.ip ?? 'unknown'}:${subject}`
    const current = attempts.get(key)

    if (!current || current.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    current.count += 1
    if (current.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfterSeconds))
      jsonError(res, 429, 'Demasiados intentos. Intenta nuevamente mas tarde.')
      return
    }

    next()
  }
}

function parseLimit(value, { fallback = 50, min = 1, max = 200 } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10)

  if (!Number.isInteger(parsed)) {
    return fallback
  }

  return Math.min(max, Math.max(min, parsed))
}

function parseOptionalMegabytes(rawValue) {
  const parsed = Number.parseFloat(String(rawValue ?? ''))

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return Math.round(parsed * 1024 * 1024)
}

function resolveActivacionesBucket(env) {
  const adminBucket = normalizeText(env.ADMIN_STORAGE_BUCKET_ACTIVACIONES)
  if (adminBucket) {
    return adminBucket
  }

  const frontendBucket = normalizeText(env.VITE_STORAGE_BUCKET_ACTIVACIONES)
  if (frontendBucket) {
    return frontendBucket
  }

  return 'fotos-activaciones'
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function resolveStorageObjectPathFromFotoUrl(fotoUrl, bucketName) {
  const normalized = normalizeText(fotoUrl)
  if (!normalized) {
    return null
  }

  let path = normalized

  if (/^https?:\/\//i.test(path)) {
    try {
      const parsedUrl = new URL(path)
      path = parsedUrl.pathname ?? ''
    } catch {
      return null
    }
  }

  path = path.split('?')[0]?.split('#')[0] ?? ''
  path = path.replace(/^\/+/, '')

  if (!path) {
    return null
  }

  const publicPrefix = `storage/v1/object/public/${bucketName}/`
  const signPrefix = `storage/v1/object/sign/${bucketName}/`

  if (path.startsWith(publicPrefix)) {
    return decodeURIComponentSafe(path.slice(publicPrefix.length)).replace(/^\/+/, '')
  }

  if (path.startsWith(signPrefix)) {
    return decodeURIComponentSafe(path.slice(signPrefix.length)).replace(/^\/+/, '')
  }

  const genericPublicPrefix = 'storage/v1/object/public/'
  if (path.startsWith(genericPublicPrefix)) {
    const afterPrefix = path.slice(genericPublicPrefix.length)
    if (!afterPrefix.startsWith(`${bucketName}/`)) {
      return null
    }

    return decodeURIComponentSafe(afterPrefix.slice(bucketName.length + 1)).replace(/^\/+/, '')
  }

  const genericSignPrefix = 'storage/v1/object/sign/'
  if (path.startsWith(genericSignPrefix)) {
    const afterPrefix = path.slice(genericSignPrefix.length)
    if (!afterPrefix.startsWith(`${bucketName}/`)) {
      return null
    }

    return decodeURIComponentSafe(afterPrefix.slice(bucketName.length + 1)).replace(/^\/+/, '')
  }

  if (path.startsWith(`${bucketName}/`)) {
    return decodeURIComponentSafe(path.slice(bucketName.length + 1)).replace(/^\/+/, '')
  }

  return decodeURIComponentSafe(path).replace(/^\/+/, '')
}

async function createActivationSignedPhotoMap(adminSupabase, bucketName, rows) {
  const entries = [...new Set(
    rows.flatMap((row) => [row.foto_url, row.foto_cash_in, row.foto_cashin]).filter(Boolean)
  )].map((value) => [value, resolveStorageObjectPathFromFotoUrl(value, bucketName)])
    .filter(([, path]) => path)
  if (!entries.length) return new Map()

  const signed = new Map()
  for (let index = 0; index < entries.length; index += 100) {
    const batch = entries.slice(index, index + 100)
    const { data, error } = await adminSupabase.storage
      .from(bucketName)
      .createSignedUrls(batch.map(([, path]) => path), 60 * 60)
    if (error) throw error
    for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
      const signedUrl = data?.[itemIndex]?.signedUrl
      if (signedUrl) signed.set(batch[itemIndex][0], signedUrl)
    }
  }
  return signed
}

async function attachActivationSignedPhotos(adminSupabase, bucketName, rows, evidenceSecret = null) {
  const signed = await createActivationSignedPhotoMap(adminSupabase, bucketName, rows)
  return rows.map((row) => ({
    ...row,
    foto_url_signed: signed.get(row.foto_url) ?? null,
    foto_cash_in_signed: signed.get(row.foto_cash_in) ?? signed.get(row.foto_cashin) ?? null,
    foto_url_evidencia: buildEvidenceLinkPath(evidenceSecret, row, 'principal', bucketName),
    foto_cash_in_evidencia: buildEvidenceLinkPath(evidenceSecret, row, 'cash-in', bucketName),
  }))
}

async function attachActivationCreatorEmail(adminSupabase, rows) {
  const ids = [...new Set(rows.map((row) => row?.usuario_id).filter(esUuid))]
  const correos = new Map()
  if (ids.length) {
    const { data, error } = await adminSupabase.from('activadores').select('usuario_id,email').in('usuario_id', ids)
    if (error) throw error
    for (const perfil of data ?? []) {
      const email = typeof perfil.email === 'string' ? perfil.email.trim() : ''
      correos.set(perfil.usuario_id, email || null)
    }
  }
  return rows.map((row) => ({ ...row, usuario_email: correos.get(row.usuario_id) ?? null }))
}

function buildEvidenceLinkPath(secret, row, tipo, bucketName) {
  if (!secret || !row?.id) {
    return null
  }

  const storedValue = tipo === 'principal' ? row.foto_url : (row.foto_cash_in ?? row.foto_cashin)
  const objectPath = resolveStorageObjectPathFromFotoUrl(storedValue, bucketName)

  if (!objectPath) {
    return null
  }

  return buildEvidencePath(row.id, tipo, buildEvidenceToken(secret, row.id, tipo, objectPath))
}

async function calculateBucketUsageBytes(adminSupabase, bucketName) {
  const directoriesQueue = ['']
  const visitedDirectories = new Set()
  let totalBytes = 0
  let totalObjects = 0

  while (directoriesQueue.length > 0) {
    const currentDirectory = directoriesQueue.shift() ?? ''

    if (visitedDirectories.has(currentDirectory)) {
      continue
    }

    visitedDirectories.add(currentDirectory)

    let offset = 0
    const limit = 1000

    while (true) {
      const { data, error } = await adminSupabase.storage.from(bucketName).list(currentDirectory, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      })

      if (error) {
        throw new Error(error.message)
      }

      if (!data?.length) {
        break
      }

      for (const item of data) {
        const name = normalizeText(item?.name)
        if (!name) {
          continue
        }

        const isDirectory = item?.id == null && !item?.metadata
        if (isDirectory) {
          const nextDirectory = currentDirectory ? `${currentDirectory}/${name}` : name
          if (!visitedDirectories.has(nextDirectory)) {
            directoriesQueue.push(nextDirectory)
          }
          continue
        }

        if (name === '.emptyFolderPlaceholder') {
          continue
        }

        totalObjects += 1

        const sizeCandidate =
          item?.metadata?.size ??
          item?.metadata?.contentLength ??
          item?.metadata?.content_length
        const size = Number(sizeCandidate)

        if (Number.isFinite(size) && size > 0) {
          totalBytes += size
        }
      }

      if (data.length < limit) {
        break
      }

      offset += limit
    }
  }

  return {
    totalBytes,
    totalObjects,
  }
}

async function estimateDatabaseUsageFromActivaciones(
  adminSupabase,
  {
    activacionesCount = 0,
    databaseLimitBytes = null,
    sampleLimit = 240,
    overheadFactor = 1.34,
  } = {}
) {
  const normalizedCount = Number(activacionesCount)
  if (!Number.isFinite(normalizedCount) || normalizedCount <= 0) {
    return {
      sample_size: 0,
      overhead_factor: overheadFactor,
      per_activation_estimated_bytes: 0,
      estimated_database_used_bytes: 0,
      estimated_database_remaining_bytes:
        databaseLimitBytes == null ? null : Math.max(0, databaseLimitBytes),
      estimated_database_usage_percent: databaseLimitBytes == null ? null : 0,
      estimated_activaciones_capacity_total: null,
      estimated_activaciones_capacity_remaining: null,
    }
  }

  const safeSampleLimit = Math.max(40, Math.min(500, Number(sampleLimit) || 240))
  const { data: sampleRows, error: sampleErr } = await adminSupabase
    .from('activaciones')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeSampleLimit)

  if (sampleErr) {
    throw new Error(sampleErr.message)
  }

  const rows = sampleRows ?? []
  if (!rows.length) {
    return {
      sample_size: 0,
      overhead_factor: overheadFactor,
      per_activation_estimated_bytes: 0,
      estimated_database_used_bytes: 0,
      estimated_database_remaining_bytes:
        databaseLimitBytes == null ? null : Math.max(0, databaseLimitBytes),
      estimated_database_usage_percent: databaseLimitBytes == null ? null : 0,
      estimated_activaciones_capacity_total: null,
      estimated_activaciones_capacity_remaining: null,
    }
  }

  const totalJsonPayloadBytes = rows.reduce((accumulator, row) => {
    try {
      return accumulator + Buffer.byteLength(JSON.stringify(row), 'utf8')
    } catch {
      return accumulator
    }
  }, 0)

  const averageJsonPayloadBytes = totalJsonPayloadBytes / rows.length
  const perActivationEstimatedBytes = Math.max(1, Math.round(averageJsonPayloadBytes * overheadFactor))
  const estimatedDatabaseUsedBytes = Math.round(perActivationEstimatedBytes * normalizedCount)
  const estimatedDatabaseRemainingBytes =
    databaseLimitBytes == null
      ? null
      : Math.max(0, Math.round(databaseLimitBytes - estimatedDatabaseUsedBytes))
  const estimatedDatabaseUsagePercent =
    databaseLimitBytes == null || databaseLimitBytes <= 0
      ? null
      : Number(((estimatedDatabaseUsedBytes / databaseLimitBytes) * 100).toFixed(2))
  const estimatedActivacionesCapacityTotal =
    databaseLimitBytes == null || databaseLimitBytes <= 0
      ? null
      : Math.max(0, Math.floor(databaseLimitBytes / perActivationEstimatedBytes))
  const estimatedActivacionesCapacityRemaining =
    estimatedActivacionesCapacityTotal == null
      ? null
      : Math.max(0, estimatedActivacionesCapacityTotal - normalizedCount)

  return {
    sample_size: rows.length,
    overhead_factor: overheadFactor,
    per_activation_estimated_bytes: perActivationEstimatedBytes,
    estimated_database_used_bytes: estimatedDatabaseUsedBytes,
    estimated_database_remaining_bytes: estimatedDatabaseRemainingBytes,
    estimated_database_usage_percent: estimatedDatabaseUsagePercent,
    estimated_activaciones_capacity_total: estimatedActivacionesCapacityTotal,
    estimated_activaciones_capacity_remaining: estimatedActivacionesCapacityRemaining,
  }
}

function estimateCombinedActivationCapacity({
  activacionesCount = 0,
  activacionesWithPhotoCount = 0,
  storageObjectsCount = 0,
  storageUsedBytes = null,
  storageRemainingBytes = null,
  databaseRemainingBytes = null,
  perActivationDatabaseBytes = null,
} = {}) {
  const normalizedActivacionesCount = Math.max(0, Number(activacionesCount) || 0)
  const normalizedActivacionesWithPhotoCount = Math.max(0, Number(activacionesWithPhotoCount) || 0)
  const normalizedStorageObjectsCount = Math.max(0, Number(storageObjectsCount) || 0)
  const normalizedStorageUsedBytes = Number.isFinite(Number(storageUsedBytes))
    ? Math.max(0, Number(storageUsedBytes))
    : null
  const normalizedStorageRemainingBytes = Number.isFinite(Number(storageRemainingBytes))
    ? Math.max(0, Number(storageRemainingBytes))
    : null
  const normalizedDatabaseRemainingBytes = Number.isFinite(Number(databaseRemainingBytes))
    ? Math.max(0, Number(databaseRemainingBytes))
    : null
  const normalizedPerActivationDatabaseBytes =
    Number.isFinite(Number(perActivationDatabaseBytes)) && Number(perActivationDatabaseBytes) > 0
      ? Math.round(Number(perActivationDatabaseBytes))
      : null

  const photoSampleCount =
    normalizedActivacionesWithPhotoCount > 0
      ? normalizedActivacionesWithPhotoCount
      : normalizedStorageObjectsCount > 0
        ? normalizedStorageObjectsCount
        : 0

  const averagePhotoBytes =
    normalizedStorageUsedBytes != null && photoSampleCount > 0
      ? Math.max(1, Math.round(normalizedStorageUsedBytes / photoSampleCount))
      : null

  const remainingByDatabase =
    normalizedDatabaseRemainingBytes != null && normalizedPerActivationDatabaseBytes != null
      ? Math.max(0, Math.floor(normalizedDatabaseRemainingBytes / normalizedPerActivationDatabaseBytes))
      : null
  const remainingByStorage =
    normalizedStorageRemainingBytes != null && averagePhotoBytes != null
      ? Math.max(0, Math.floor(normalizedStorageRemainingBytes / averagePhotoBytes))
      : null

  const estimatedRemaining =
    remainingByDatabase != null && remainingByStorage != null
      ? Math.min(remainingByDatabase, remainingByStorage)
      : remainingByDatabase ?? remainingByStorage

  const limitingFactor =
    remainingByDatabase != null && remainingByStorage != null
      ? remainingByStorage <= remainingByDatabase
        ? 'storage'
        : 'database'
      : remainingByStorage != null
        ? 'storage'
        : remainingByDatabase != null
          ? 'database'
          : null

  const unavailableReasons = []
  if (averagePhotoBytes == null) {
    unavailableReasons.push('Sin muestra de fotos para calcular promedio.')
  }
  if (normalizedPerActivationDatabaseBytes == null) {
    unavailableReasons.push('Sin muestra suficiente para calcular peso de activacion en base de datos.')
  }

  const estimatedTotal =
    estimatedRemaining == null ? null : Math.max(normalizedActivacionesCount, normalizedActivacionesCount + estimatedRemaining)
  const perActivationTotalEstimatedBytes =
    normalizedPerActivationDatabaseBytes != null && averagePhotoBytes != null
      ? normalizedPerActivationDatabaseBytes + averagePhotoBytes
      : null
  const photoCoveragePercent =
    normalizedActivacionesCount > 0
      ? Number(
          (
            (Math.min(normalizedActivacionesWithPhotoCount, normalizedActivacionesCount) /
              normalizedActivacionesCount) *
            100
          ).toFixed(2)
        )
      : null

  return {
    one_photo_per_activation_assumed: true,
    activaciones_with_photo_count: normalizedActivacionesWithPhotoCount,
    photo_coverage_percent: photoCoveragePercent,
    sample_photos_count: photoSampleCount,
    average_photo_bytes: averagePhotoBytes,
    per_activation_database_estimated_bytes: normalizedPerActivationDatabaseBytes,
    per_activation_total_estimated_bytes: perActivationTotalEstimatedBytes,
    estimated_activaciones_with_photo_total: estimatedTotal,
    estimated_activaciones_with_photo_remaining: estimatedRemaining,
    estimated_remaining_by_database: remainingByDatabase,
    estimated_remaining_by_storage: remainingByStorage,
    limiting_factor: limitingFactor,
    unavailable_reason: unavailableReasons.length ? unavailableReasons.join(' ') : null,
  }
}

export function createAdminApiApp({ env = process.env, adminSupabase: injectedSupabase = null, metricsPageSize = 1000 } = {}) {
  assertRequiredEnv(env)

  const allowedOrigins = buildAllowedOrigins(env.ADMIN_API_CORS_ORIGIN)
  const allowedOriginMatchers = allowedOrigins.map(buildOriginMatcher)
  const activacionesBucket = resolveActivacionesBucket(env)
  const configuredStorageLimitBytes = parseOptionalMegabytes(env.ADMIN_STORAGE_LIMIT_MB)
  const configuredDatabaseLimitBytes = parseOptionalMegabytes(env.ADMIN_DATABASE_LIMIT_MB)
  const storageLimitBytes =
    configuredStorageLimitBytes ?? SUPABASE_FREE_PLAN_REFERENCE.file_storage_limit_bytes
  const databaseLimitBytes =
    configuredDatabaseLimitBytes ?? SUPABASE_FREE_PLAN_REFERENCE.database_limit_bytes
  const storageLimitSource =
    configuredStorageLimitBytes == null ? 'supabase_free_default' : 'env_admin_storage_limit_mb'
  const databaseLimitSource =
    configuredDatabaseLimitBytes == null ? 'supabase_free_default' : 'env_admin_database_limit_mb'
  const adminSupabase = injectedSupabase ?? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  async function attachUserRoles(users) {
    if (!users.length) return users
    const { data, error } = await adminSupabase.from('activador_roles')
      .select('usuario_id,rol').in('usuario_id', users.map((user) => user.usuario_id))
    if (error) throw error
    return users.map((user) => {
      const roles = (data ?? []).filter((row) => row.usuario_id === user.usuario_id).map((row) => row.rol)
      return { ...user, roles: roles.length ? roles : [user.rol] }
    })
  }

  async function syncUserRoles(userId, roles) {
    if (roles.length) {
      const { error } = await adminSupabase.from('activador_roles')
        .upsert(roles.map((rol) => ({ usuario_id: userId, rol })), { onConflict: 'usuario_id,rol' })
      if (error) throw error
    }
    let query = adminSupabase.from('activador_roles').delete().eq('usuario_id', userId)
    if (roles.length) query = query.not('rol', 'in', `(${roles.join(',')})`)
    const { error } = await query
    if (error) throw error
  }

  async function syncFacturadorTeams(userId, nombre, teamIds, hasFacturadorRole) {
    const normalizedIds = [...new Set((teamIds ?? []).map(normalizeText).filter(Boolean))]
    const { data: linkedBiller, error: linkedError } = await adminSupabase.from('facturadores')
      .select('id').eq('usuario_id', userId).maybeSingle()
    if (linkedError) throw linkedError

    if (!hasFacturadorRole) {
      if (linkedBiller) {
        const { error } = await adminSupabase.from('facturadores')
          .update({ usuario_id: null }).eq('id', linkedBiller.id).eq('usuario_id', userId)
        if (error) throw error
      }
      return
    }

    const { data: role, error: roleError } = await adminSupabase.from('activador_roles')
      .select('usuario_id').eq('usuario_id', userId).eq('rol', 'facturador').maybeSingle()
    if (roleError) throw roleError
    if (!role) throw new Error('El usuario debe tener rol facturador para asignar equipos facturados.')

    let biller = linkedBiller
    if (!biller) {
      const { data: selectedTeams, error: selectedTeamsError } = normalizedIds.length
        ? await adminSupabase.from('equipos').select('facturador_id').in('id', normalizedIds)
        : { data: [], error: null }
      if (selectedTeamsError) throw selectedTeamsError
      const existingBillerIds = [...new Set((selectedTeams ?? []).map((team) => team.facturador_id).filter(Boolean))]
      if (existingBillerIds.length === 1) {
        const { data: availableBiller, error: availableError } = await adminSupabase.from('facturadores')
          .select('id').eq('id', existingBillerIds[0]).is('usuario_id', null).maybeSingle()
        if (availableError) throw availableError
        if (availableBiller) {
          const { data: linked, error: linkError } = await adminSupabase.from('facturadores')
            .update({ usuario_id: userId, nombre }).eq('id', availableBiller.id).is('usuario_id', null)
            .select('id').single()
          if (linkError) throw linkError
          biller = linked
        }
      }
    }
    if (!biller) {
      const codigo = `USR-${userId}`
      const { data: reusable, error: reusableError } = await adminSupabase.from('facturadores')
        .select('id').eq('codigo', codigo).is('usuario_id', null).maybeSingle()
      if (reusableError) throw reusableError
      if (reusable) {
        const { data: linked, error: linkError } = await adminSupabase.from('facturadores')
          .update({ usuario_id: userId, nombre }).eq('id', reusable.id).is('usuario_id', null)
          .select('id').single()
        if (linkError) throw linkError
        biller = linked
      } else {
        const { data: created, error: createError } = await adminSupabase.from('facturadores').insert({
          codigo,
          nombre,
          usuario_id: userId,
        }).select('id').single()
        if (createError) throw createError
        biller = created
      }
    } else {
      const { error: nameError } = await adminSupabase.from('facturadores')
        .update({ nombre }).eq('id', biller.id)
      if (nameError) throw nameError
    }

    const { data: currentTeams, error: currentError } = await adminSupabase.from('equipos')
      .select('id').eq('facturador_id', biller.id)
    if (currentError) throw currentError
    const removedIds = (currentTeams ?? []).map((team) => team.id).filter((id) => !normalizedIds.includes(id))

    if (removedIds.length) {
      const { error } = await adminSupabase.from('equipos')
        .update({ facturador_id: null }).in('id', removedIds).eq('facturador_id', biller.id)
      if (error) throw error
    }
    if (normalizedIds.length) {
      const { error } = await adminSupabase.from('equipos')
        .update({ facturador_id: biller.id }).in('id', normalizedIds)
      if (error) throw error
    }
  }

  async function enrichUsersWithOrganization(users) {
    if (!users.length) return users
    const teamIds = [...new Set(users.map((user) => user.equipo_id).filter(Boolean))]
    const userIds = users.map((user) => user.usuario_id).filter(Boolean)
    if (!teamIds.length && !userIds.length) return users

    try {
      const now = new Date().toISOString()
      let [{ data: teams, error: teamsError }, { data: temporaryPlazas, error: temporaryError }] =
        await Promise.all([
          teamIds.length
            ? adminSupabase.from('equipos').select('id,numero,nombre,facturador_id,lider_actual_id,plaza_id').in('id', teamIds)
            : Promise.resolve({ data: [], error: null }),
          userIds.length
            ? adminSupabase.from('activador_plaza_temporal')
              .select('activador_id,plaza_temporal,inicio,fin,motivo,autorizado_por,tipo_zona,ciudad_plaza,activo')
              .in('activador_id', userIds).lte('inicio', now).gte('fin', now).eq('activo', true).is('cancelado_at', null)
            : Promise.resolve({ data: [], error: null }),
        ])
      if (teamsError && teamIds.length) {
        const legacyTeams = await adminSupabase.from('equipos')
          .select('id,numero,nombre,facturador_id,lider_actual_id').in('id', teamIds)
        teams = legacyTeams.data
        teamsError = legacyTeams.error
      }
      if (teamsError || temporaryError) return users

      let { data: ledTeams, error: ledTeamsError } = userIds.length
        ? await adminSupabase.from('equipos')
          .select('id,numero,nombre,facturador_id,lider_actual_id,plaza_id,activo').in('lider_actual_id', userIds)
        : { data: [], error: null }
      if (ledTeamsError && userIds.length) {
        const legacyLedTeams = await adminSupabase.from('equipos')
          .select('id,numero,nombre,facturador_id,lider_actual_id,activo').in('lider_actual_id', userIds)
        ledTeams = legacyLedTeams.data
        ledTeamsError = legacyLedTeams.error
      }
      if (ledTeamsError) return users

      let linkedBillers = []
      if (userIds.length) {
        const linkedResult = await adminSupabase.from('facturadores')
          .select('id,codigo,nombre,usuario_id').in('usuario_id', userIds)
        if (!linkedResult.error) linkedBillers = linkedResult.data ?? []
      }
      const linkedBillerIds = linkedBillers.map((item) => item.id)
      const { data: billedTeams, error: billedTeamsError } = linkedBillerIds.length
        ? await adminSupabase.from('equipos')
          .select('id,numero,nombre,facturador_id,lider_actual_id,plaza_id,activo').in('facturador_id', linkedBillerIds)
        : { data: [], error: null }
      if (billedTeamsError) return users
      teams = [...new Map([...(teams ?? []), ...(ledTeams ?? []), ...(billedTeams ?? [])].map((team) => [team.id, team])).values()]

      const facturadorIds = [...new Set((teams ?? []).map((team) => team.facturador_id).filter(Boolean))]
      const plazaIds = [...new Set((teams ?? []).map((team) => team.plaza_id).filter(Boolean))]
      const leaderIds = [...new Set((teams ?? []).map((team) => team.lider_actual_id).filter(Boolean))]
      const [{ data: billers, error: billersError }, { data: plazas, error: plazasError }, { data: leaders, error: leadersError }] = await Promise.all([
        facturadorIds.length
          ? adminSupabase.from('facturadores').select('id,codigo,nombre').in('id', facturadorIds)
          : Promise.resolve({ data: [], error: null }),
        plazaIds.length
          ? adminSupabase.from('plazas').select('id,nombre').in('id', plazaIds)
          : Promise.resolve({ data: [], error: null }),
        leaderIds.length
          ? adminSupabase.from('activadores').select('usuario_id,nombre').in('usuario_id', leaderIds)
          : Promise.resolve({ data: [], error: null }),
      ])
      if (billersError || plazasError || leadersError) return users

      const teamsById = new Map((teams ?? []).map((team) => [team.id, team]))
      const billersById = new Map([...(billers ?? []), ...linkedBillers].map((biller) => [biller.id, biller]))
      const billerByUser = new Map(linkedBillers.map((biller) => [biller.usuario_id, biller]))
      const plazasById = new Map((plazas ?? []).map((plaza) => [plaza.id, plaza]))
      const leadersById = new Map((leaders ?? []).map((leader) => [leader.usuario_id, leader]))
      const temporaryByUser = new Map((temporaryPlazas ?? []).map((item) => [item.activador_id, item]))
      return users.map((user) => {
        const team = teamsById.get(user.equipo_id)
        const biller = billersById.get(team?.facturador_id)
        const temporary = temporaryByUser.get(user.usuario_id)
        const teamPlaza = plazasById.get(team?.plaza_id)
        const assignedTeams = (teams ?? []).filter((item) => item.lider_actual_id === user.usuario_id)
        const userBiller = billerByUser.get(user.usuario_id)
        const billedUserTeams = userBiller
          ? (teams ?? []).filter((item) => item.facturador_id === userBiller.id)
          : []
        const assignedBiller = billersById.get(assignedTeams[0]?.facturador_id)
        return {
          ...user,
          plaza_base: user.plaza_base ?? user.plaza ?? null,
          plaza_efectiva: temporary?.plaza_temporal ?? user.plaza_base ?? user.plaza ?? null,
          plaza_temporal_activa: Boolean(temporary),
          plaza_temporal_vigente: temporary ?? null,
          plaza_id: team?.plaza_id ?? null,
          plaza_nombre: teamPlaza?.nombre ?? user.plaza_base ?? user.plaza ?? null,
          equipo_numero: team?.numero ?? null,
          equipo_nombre: team?.nombre ?? null,
          equipos_asignados: assignedTeams.map((item) => ({
            id: item.id,
            numero: item.numero,
            nombre: item.nombre,
            plaza: plazasById.get(item.plaza_id)?.nombre ?? null,
            facturador: billersById.get(item.facturador_id)?.nombre ?? null,
            activo: item.activo,
          })),
          equipos_facturados: billedUserTeams.map((item) => ({
            id: item.id,
            numero: item.numero,
            nombre: item.nombre,
            plaza: plazasById.get(item.plaza_id)?.nombre ?? null,
            activo: item.activo,
          })),
          lider_id: team?.lider_actual_id ?? user.lider_id ?? null,
          lider_nombre: leadersById.get(team?.lider_actual_id ?? user.lider_id)?.nombre ?? null,
          facturador_id: userBiller?.id ?? biller?.id ?? assignedBiller?.id ?? null,
          facturador_codigo: userBiller?.codigo ?? biller?.codigo ?? assignedBiller?.codigo ?? null,
          facturador_nombre: userBiller?.nombre ?? biller?.nombre ?? assignedBiller?.nombre ?? null,
        }
      })
    } catch {
      // Compatibilidad mientras la migracion organizacional aun no fue aplicada.
      return users
    }
  }

  async function resolveTeamIdForLeader(leaderId, plaza) {
    try {
      const normalizedPlaza = normalizeOrganizationName(plaza)
      if (!normalizedPlaza) return null
      const { data: plazaRow, error: plazaError } = await adminSupabase.from('plazas')
        .select('id').eq('nombre_normalizado', normalizedPlaza).maybeSingle()
      if (plazaError) {
        let legacyQuery = adminSupabase.from('equipos').select('id').eq('activo', true)
        legacyQuery = leaderId
          ? legacyQuery.eq('lider_actual_id', leaderId)
          : legacyQuery.eq('nombre', 'Equipo sin asignar')
        const { data: legacyTeam, error: legacyError } = await legacyQuery.order('numero').limit(1).maybeSingle()
        return legacyError ? null : legacyTeam?.id ?? null
      }
      if (!plazaRow) return null
      let query = adminSupabase.from('equipos').select('id').eq('activo', true).eq('plaza_id', plazaRow.id)
      query = leaderId ? query.eq('lider_actual_id', leaderId) : query.eq('nombre', 'Equipo sin asignar')
      const { data, error } = await query.order('numero').limit(1).maybeSingle()
      return error ? null : data?.id ?? null
    } catch {
      return null
    }
  }

  async function resolveOrCreatePlaza(nombre) {
    const normalized = normalizeOrganizationName(nombre)
    if (!normalized) return null
    const { data: existing, error: readError } = await adminSupabase.from('plazas')
      .select('id').eq('nombre_normalizado', normalized).maybeSingle()
    if (!readError && existing) return existing.id
    if (readError) return null
    const { data: created, error: createError } = await adminSupabase.from('plazas')
      .insert({ nombre: normalizeText(nombre), nombre_normalizado: normalized })
      .select('id').single()
    if (!createError) return created.id
    const { data: concurrent } = await adminSupabase.from('plazas')
      .select('id').eq('nombre_normalizado', normalized).maybeSingle()
    return concurrent?.id ?? null
  }

  async function loadOrganizationOptions() {
    const [plazasResult, teamsResult, billersResult] = await Promise.all([
      adminSupabase.from('plazas').select('id,nombre,nombre_normalizado,activa').eq('activa', true).order('nombre'),
      adminSupabase.from('equipos').select('id,numero,nombre,facturador_id,plaza_id,lider_actual_id,activo').order('numero'),
      adminSupabase.from('facturadores').select('id,codigo,nombre,usuario_id,activo').eq('activo', true).order('nombre'),
    ])
    const firstError = plazasResult.error || teamsResult.error || billersResult.error
    if (firstError) {
      if (isMissingOrganizationSchema(firstError)) {
        return { available: false, message: 'El modelo organizacional aun no esta habilitado; se mantiene el esquema anterior.', plazas: [], equipos: [], facturadores: [] }
      }
      throw firstError
    }
    return {
      available: true,
      message: null,
      plazas: plazasResult.data ?? [],
      equipos: teamsResult.data ?? [],
      facturadores: billersResult.data ?? [],
    }
  }

  async function syncLeaderTeams(leaderId, teamIds) {
    const normalizedIds = [...new Set((teamIds ?? []).map(normalizeText).filter(Boolean))]
    const { error } = await adminSupabase.rpc('asignar_equipos_lider', {
      p_lider_id: leaderId,
      p_equipo_ids: normalizedIds,
      p_inicio: new Date().toISOString(),
      p_motivo: 'Actualizacion administrativa de usuario',
    })
    if (error) {
      if (isMissingOrganizationSchema(error)) return { available: false }
      throw error
    }
    return { available: true }
  }

  const app = express()
  app.set('trust proxy', true)

  app.use(applySecurityHeaders)

  app.use((req, res, next) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''

    if (origin && !isOriginAllowed(origin, req, allowedOriginMatchers)) {
      jsonError(res, 403, `Origin no permitido: ${origin}`)
      return
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
      res.setHeader('Access-Control-Expose-Headers', 'X-Export-Row-Count,X-Export-Images,X-Export-Version')
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  })

  app.use(express.json({ limit: REQUEST_BODY_LIMIT }))
  app.use(express.urlencoded({ extended: false, limit: REQUEST_BODY_LIMIT }))
  app.use(handleBodyParseError)

  async function resolvePortalUser(req) {
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    if (!authorization.startsWith('Bearer ')) return null
    const { data: authData, error: authError } = await adminSupabase.auth.getUser(authorization.slice(7))
    if (authError || !authData.user) return null
    const { data: profile } = await adminSupabase.from('activadores').select('usuario_id,auth_user_id,nombre,email,rol,estado,lider_id,puede_activar').eq('auth_user_id', authData.user.id).maybeSingle()
    if (!profile || profile.estado !== 'activo') return null
    const { data: roleRows, error: rolesError } = await adminSupabase
      .from('activador_roles')
      .select('rol')
      .eq('usuario_id', profile.usuario_id)
    if (rolesError) {
      return ['administrador', 'lider', 'banco'].includes(profile.rol)
        ? { ...profile, roles: [profile.rol] }
        : null
    }
    const roles = [...new Set([profile.rol, ...(roleRows ?? []).map((row) => row.rol)].filter(Boolean))]
    if (!roles.includes('administrador') && !['lider', 'banco'].includes(profile.rol)) return null
    return { ...profile, roles }
  }

  async function requirePortalAuth(req, res, next) {
    const profile = await (req.timing ? req.timing.measure('auth', () => resolvePortalUser(req)) : resolvePortalUser(req))
    if (!profile) { jsonError(res, 401, 'Sesion invalida o usuario sin permisos.'); return }
    req.portalUser = profile
    next()
  }

  async function requireAdminBasicAuth(req, res, next) {
    const parsed = parseBasicAuth(req.headers.authorization)
    if (!parsed) {
      const profile = await resolvePortalUser(req)
      const isActivationEdit = req.method === 'PATCH' && /^\/activaciones\/[^/]+\/?$/.test(req.path)
      const canEditActivation = isActivationEdit && profile?.roles?.includes('administrador')
      if (profile?.rol === 'administrador' || canEditActivation) { req.portalUser = profile; next(); return }
      if (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
        jsonError(res, 403, 'Se requiere un administrador activo.')
        return
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="admin-api"')
      jsonError(res, 401, 'Credenciales requeridas.')
      return
    }

    const isValidUser = timingSafeEqualText(parsed.username, env.ADMIN_BASIC_USER)
    const isValidPass = timingSafeEqualText(parsed.password, env.ADMIN_BASIC_PASS)

    if (!isValidUser || !isValidPass) {
      jsonError(res, 401, 'Credenciales invalidas.')
      return
    }

    req.adminUser = parsed.username
    next()
  }

  async function requireAdminReauthentication(req, res, next) {
    if (req.portalUser?.rol !== 'administrador') {
      jsonError(res, 403, 'Se requiere un administrador autenticado por Bearer.')
      return
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (req.body && typeof req.body === 'object') delete req.body.password
    if (!password) {
      jsonError(res, 400, 'La contraseña actual es obligatoria.')
      return
    }

    const authEmail = normalizeEmail(req.portalUser.email)
    if (!authEmail) {
      jsonError(res, 401, 'No se pudo reautenticar al administrador.')
      return
    }

    const verificationClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data, error } = await verificationClient.auth.signInWithPassword({
      email: authEmail,
      password,
    })
    if (error || data.user?.id !== req.portalUser.auth_user_id) {
      jsonError(res, 401, 'Contraseña incorrecta.')
      return
    }

    next()
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/evidencia/:activacionId/:tipo/:token', createAdminRateLimiter(EVIDENCE_LINK_RATE_LIMIT), asyncRoute(async (req, res) => {
    const activacionId = normalizeText(req.params.activacionId)
    const tipo = normalizeText(req.params.tipo)
    const token = normalizeText(req.params.token)
    const column = EVIDENCE_LINK_TYPES[tipo]

    if (!activacionId || !column || !EVIDENCE_LINK_TOKEN_PATTERN.test(token)) {
      jsonError(res, 404, 'No encontrado.')
      return
    }

    const { data: row, error } = await adminSupabase.from('activaciones')
      .select('id,foto_url,foto_cash_in')
      .eq('id', activacionId)
      .maybeSingle()

    if (error || !row) {
      jsonError(res, 404, 'No encontrado.')
      return
    }

    const storedValue = tipo === 'principal' ? row.foto_url : (row.foto_cash_in ?? row.foto_cashin)
    const objectPath = resolveStorageObjectPathFromFotoUrl(storedValue, activacionesBucket)

    if (!objectPath || !verifyEvidenceToken(env.EVIDENCE_LINK_SECRET, activacionId, tipo, objectPath, token)) {
      jsonError(res, 404, 'No encontrado.')
      return
    }

    const { data: signedData, error: signError } = await adminSupabase.storage
      .from(activacionesBucket)
      .createSignedUrls([objectPath], EVIDENCE_LINK_SIGNED_TTL_SECONDS)
    const signedUrl = signedData?.[0]?.signedUrl

    if (signError || !signedUrl) {
      console.error('[admin-api] No se pudo firmar una evidencia.', sanitizeLogDetails(signError))
      jsonError(res, 500, 'No se pudo resolver la evidencia.')
      return
    }

    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('CDN-Cache-Control', 'no-store')
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
    res.redirect(302, signedUrl)
  }))

  function withAccessFlag(users) {
    return (users ?? []).map(({ auth_user_id, ...rest }) => ({ ...rest, cuenta_acceso_eliminada: auth_user_id == null }))
  }

  app.use('/portal', serverTimingMiddleware, requirePortalAuth)
  app.get('/portal/me', asyncRoute(async (req, res) => {
    const [profile] = await attachUserRoles([req.portalUser])
    const { auth_user_id, ...safeProfile } = profile ?? {}
    res.json({ profile: safeProfile })
  }))
  app.get('/portal/plazas', asyncRoute(async (_req, res) => {
    const { data, error } = await adminSupabase.from('plazas').select('id,nombre').eq('activa', true).order('nombre')
    if (error) {
      if (isMissingOrganizationSchema(error)) { res.json({ plazas: [] }); return }
      jsonError(res, 500, 'No se pudo obtener las plazas.', error.message)
      return
    }
    res.json({ plazas: data ?? [] })
  }))
  app.get('/portal/users', asyncRoute(async (req, res) => {
    let query = adminSupabase.from('activadores').select('*').order('nombre')
    if (req.portalUser.rol === 'lider') query = query.eq('lider_id', req.portalUser.usuario_id)
    if (req.portalUser.rol === 'banco') query = query.eq('rol', 'activador')
    const { data, error } = await query
    if (error) { jsonError(res, 500, 'No se pudo obtener usuarios.', error.message); return }
    const users = data ?? []
    const leaderIds = [...new Set(users.map((item) => item.lider_id).filter(Boolean))]
    let leaderNames = new Map()
    if (leaderIds.length) {
      const { data: leaders, error: leadersError } = await adminSupabase
        .from('activadores')
        .select('usuario_id,nombre')
        .in('usuario_id', leaderIds)
      if (leadersError) { jsonError(res, 500, 'No se pudo resolver los lideres.', leadersError.message); return }
      leaderNames = new Map((leaders ?? []).map((leader) => [leader.usuario_id, leader.nombre]))
    }
    const resolvedUsers = users.map((item) => ({ ...item, lider_nombre: leaderNames.get(item.lider_id) ?? null }))
    res.json({ users: withAccessFlag(await attachUserRoles(await enrichUsersWithOrganization(resolvedUsers))) })
  }))
  app.get('/portal/activations/export-excel', asyncRoute(async (req, res) => {
    let alcance = null
    if (req.portalUser.rol === 'lider') {
      const { data: team, error: teamError } = await adminSupabase
        .from('activadores')
        .select('usuario_id')
        .eq('lider_id', req.portalUser.usuario_id)
      if (teamError) {
        jsonError(res, 500, 'No se pudo resolver el equipo.', teamError.message)
        return
      }
      alcance = {
        userIds: (team ?? []).map((item) => item.usuario_id),
        liderId: req.portalUser.usuario_id,
      }
    }

    const filters = {
      plaza: normalizeText(req.query.plaza),
      distrito: normalizeText(req.query.distrito),
      impulsador: normalizeText(req.query.impulsador),
      fechaDesde: normalizeText(req.query.fechaDesde),
      fechaHasta: normalizeText(req.query.fechaHasta),
    }
    const evidenceBaseUrl = resolveEvidencePublicBaseUrl(env.EVIDENCE_PUBLIC_BASE_URL)
    if (!evidenceBaseUrl) {
      jsonError(res, 500, 'Enlaces de evidencia no configurados.')
      return
    }
    const result = await generateActivacionesExcel({
      adminSupabase,
      bucket: activacionesBucket,
      filters,
      alcance,
      buildEvidenceUrl: (activacionId, tipo, objectPath) => `${evidenceBaseUrl}${buildEvidencePath(
        activacionId,
        tipo,
        buildEvidenceToken(env.EVIDENCE_LINK_SECRET, activacionId, tipo, objectPath),
      )}`,
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="activaciones.xlsx"')
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.setHeader('CDN-Cache-Control', 'no-store')
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
    res.setHeader('X-Export-Row-Count', String(result.rowCount))
    res.setHeader('X-Export-Images', 'links')
    res.setHeader('X-Export-Version', 'links-v2')
    res.send(Buffer.from(result.buffer))
  }))

  const obtenerCiudades = crearCatalogoCiudades(adminSupabase)
  app.get('/portal/activations/page', asyncRoute(async (req, res) => {
    const filtros = normalizarFiltros(req.query)
    const { page, pageSize } = parsearPagina(req.query)
    const { alcance, error: teamError } = await req.timing.measure('team', () => resolverAlcanceLider(adminSupabase, req.portalUser))
    if (teamError) { jsonError(res, 500, 'No se pudo resolver el equipo.', teamError.message); return }
    const ciudades = await req.timing.measure('ciudades', () => resolverCiudadesFiltro(obtenerCiudades, filtros))
    const construir = (select, options) => {
      let query = adminSupabase.from('activaciones').select(select, options)
      query = aplicarFiltrosActivaciones(query, filtros, ciudades)
      return query && alcance ? aplicarAlcanceLider(query, alcance) : query
    }
    const base = construir(SELECT_LISTADO_ACTIVACIONES, { count: 'exact' })
    if (!base) { res.json({ activations: [], total: 0, page, pageSize }); return }
    const from = (page - 1) * pageSize
    const { data, count, error } = await req.timing.measure('db', () => base
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1))
    if (error?.code === 'PGRST103') {
      const { count: total } = await construir('id', { count: 'exact', head: true })
      res.json({ activations: [], total: total ?? 0, page, pageSize })
      return
    }
    if (error) { jsonError(res, 500, 'No se pudo obtener activaciones.', error.message); return }
    res.json({ activations: data ?? [], total: count ?? 0, page, pageSize })
  }))

  app.get('/portal/metrics/activations', asyncRoute(async (req, res) => {
    const { alcance, error: teamError } = await req.timing.measure('team', () => resolverAlcanceLider(adminSupabase, req.portalUser))
    if (teamError) { jsonError(res, 500, 'No se pudo resolver el equipo.', teamError.message); return }
    const construirConsulta = (select, options) => {
      const query = adminSupabase.from('activaciones').select(select, options)
      return alcance ? aplicarAlcanceLider(query, alcance) : query
    }
    let activations
    try {
      activations = await req.timing.measure('db', () => cargarActivacionesMetricas({ construirConsulta, pageSize: metricsPageSize }))
    } catch (error) {
      jsonError(res, 500, 'No se pudo obtener activaciones.', error?.message)
      return
    }
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.json({ activations, generatedAt: new Date().toISOString() })
  }))

  app.get('/portal/activations/export-rows', asyncRoute(async (req, res) => {
    const { alcance, error: teamError } = await resolverAlcanceLider(adminSupabase, req.portalUser)
    if (teamError) { jsonError(res, 500, 'No se pudo resolver el equipo.', teamError.message); return }
    const rows = await fetchActivaciones(adminSupabase, normalizarFiltros(req.query), alcance)
    const conCorreo = await attachActivationCreatorEmail(adminSupabase, rows)
    res.setHeader('Cache-Control', 'private, no-store, max-age=0')
    res.json({
      activations: conCorreo.map((row) => ({
        ...row,
        foto_url_evidencia: buildEvidenceLinkPath(env.EVIDENCE_LINK_SECRET, row, 'principal', activacionesBucket),
        foto_cash_in_evidencia: buildEvidenceLinkPath(env.EVIDENCE_LINK_SECRET, row, 'cash-in', activacionesBucket),
      })),
    })
  }))

  app.get('/portal/activations/:id', asyncRoute(async (req, res) => {
    const id = String(req.params.id ?? '')
    if (!esUuid(id)) { jsonError(res, 400, 'Identificador de activacion invalido.'); return }
    const { alcance, error: teamError } = await resolverAlcanceLider(adminSupabase, req.portalUser)
    if (teamError) { jsonError(res, 500, 'No se pudo resolver el equipo.', teamError.message); return }
    let query = adminSupabase.from('activaciones').select('*').eq('id', id)
    if (alcance) query = aplicarAlcanceLider(query, alcance)
    if (!query) { jsonError(res, 404, 'Activacion no encontrada.'); return }
    const { data, error } = await query.maybeSingle()
    if (error) { jsonError(res, 500, 'No se pudo obtener la activacion.', error.message); return }
    if (!data) { jsonError(res, 404, 'Activacion no encontrada.'); return }
    try {
      const conCorreo = await attachActivationCreatorEmail(adminSupabase, [data])
      const [activation] = await attachActivationSignedPhotos(adminSupabase, activacionesBucket, conCorreo, env.EVIDENCE_LINK_SECRET)
      res.json({ activation })
    } catch (photoError) {
      jsonError(res, 500, 'No se pudo preparar enlaces seguros de evidencias.', photoError?.message)
    }
  }))

  app.use('/admin', createAdminRateLimiter(ADMIN_RATE_LIMIT), requireAdminBasicAuth)

  app.get('/admin/healthz', (_req, res) => {
    res.json({ ok: true })
  })

  app.get(
    '/admin/users',
    asyncRoute(async (_req, res) => {
      const { data, error } = await adminSupabase
        .from('activadores')
        .select('*')
        .order('nombre', { ascending: true })

      if (error) {
        jsonError(res, 500, error.message)
        return
      }

      res.json({ users: withAccessFlag(await attachUserRoles(await enrichUsersWithOrganization(data ?? []))) })
    })
  )

  app.post(
    '/admin/users',
    asyncRoute(async (req, res) => {
      const rawEmail = req.body?.email
      const rawPassword = req.body?.password
      const requestedTeamId = normalizeNullableText(req.body?.equipo_id)
      const requestedTeamIds = Array.isArray(req.body?.equipo_ids) ? req.body.equipo_ids : []
      const requestedBillerTeamIds = Array.isArray(req.body?.facturador_equipo_ids) ? req.body.facturador_equipo_ids : []
      const rawNombre = req.body?.nombre
      const rawPlaza = req.body?.plaza
      let roleSelection
      try { roleSelection = resolveUserRoles(req.body) }
      catch (error) { jsonError(res, 400, error.message); return }
      const { rol, roles } = roleSelection
      const esLider = roles.includes('lider')
      const esActivador = roles.includes('activador')
      const esFacturador = roles.includes('facturador')
      const estado = normalizeText(req.body?.estado) || 'activo'
      const puedeActivar = rol === 'lider' && req.body?.puede_activar === true
      let liderId = esActivador ? normalizeNullableText(req.body?.lider_id) : null
      const motivoInhabilitacion = normalizeNullableText(req.body?.motivo_inhabilitacion)

      const email = normalizeEmail(rawEmail)
      const password = typeof rawPassword === 'string' ? rawPassword : ''
      const nombre = normalizeText(rawNombre)
      let plaza = normalizeNullableText(rawPlaza)
      let teamId = null
      let teamPlazaId = null

      if (esActivador) {
        const options = await loadOrganizationOptions()
        if (options.available && requestedTeamId) {
          const selectedTeam = options.equipos.find((team) => team.id === requestedTeamId && team.activo)
          const selectedPlaza = options.plazas.find((item) => item.id === selectedTeam?.plaza_id)
          if (!selectedTeam || !selectedPlaza) {
            jsonError(res, 400, 'El equipo seleccionado debe estar activo y tener una plaza valida.')
            return
          }
          teamId = selectedTeam.id
          teamPlazaId = selectedTeam.plaza_id
          liderId = selectedTeam.lider_actual_id ?? null
          plaza = selectedPlaza.nombre
        }
      }
      if (esActivador && !teamId && req.body?.equipo_id === undefined) teamId = await resolveTeamIdForLeader(liderId, plaza)

      let leaderOrganizationAvailable = false
      if (esLider) {
        const options = await loadOrganizationOptions()
        leaderOrganizationAvailable = options.available
        if (options.available) {

          const selectedTeams = options.equipos.filter((team) => requestedTeamIds.includes(team.id))
          if (selectedTeams.length !== new Set(requestedTeamIds).size) {
            jsonError(res, 400, 'Uno o mas equipos seleccionados no existen o estan inactivos.')
            return
          }
        }
      }

      let billerOrganizationAvailable = false
      if (esFacturador) {
        const options = await loadOrganizationOptions()
        billerOrganizationAvailable = options.available
        if (options.available) {
          const selectedTeams = options.equipos.filter((team) => requestedBillerTeamIds.includes(team.id) && team.activo)
          if (selectedTeams.length !== new Set(requestedBillerTeamIds).size) {
            jsonError(res, 400, 'Uno o mas equipos facturados no existen o estan inactivos.')
            return
          }
        }
      }

      if (!email || !password || !nombre) {
        jsonError(res, 400, 'email, password y nombre son obligatorios.')
        return
      }

      if (!isValidEmail(email)) {
        jsonError(res, 400, 'email invalido.')
        return
      }

      if (!isStrongPassword(password)) {
        jsonError(res, 400, 'La contrasena debe tener al menos 10 caracteres, mayuscula, minuscula, numero y simbolo.')
        return
      }

      if (!ALLOWED_USER_ROLES.has(rol) || !ALLOWED_USER_STATES.has(estado)) {
        jsonError(res, 400, 'rol o estado invalido.')
        return
      }

      if (estado === 'inhabilitado' && !motivoInhabilitacion) {
        jsonError(res, 400, 'El motivo de inhabilitacion es obligatorio.')
        return
      }

      if (liderId) {
        const { data: leader, error: leaderErr } = await adminSupabase.from('activadores')
          .select('usuario_id').eq('usuario_id', liderId).eq('estado', 'activo').maybeSingle()
        const { data: leaderRole, error: leaderRoleErr } = await adminSupabase.from('activador_roles')
          .select('usuario_id').eq('usuario_id', liderId).eq('rol', 'lider').maybeSingle()
        if (leaderErr || !leader || leaderRoleErr || !leaderRole) {
          jsonError(res, 400, 'lider_id debe corresponder a un lider activo.', leaderErr?.message ?? leaderRoleErr?.message)
          return
        }
      }

      const { data: created, error: createErr } = await adminSupabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { nombre, plaza },
      })

      if (createErr || !created?.user) {
        jsonError(res, 400, createErr?.message ?? 'No se pudo crear el usuario en Auth.')
        return
      }

      const insertedUser = {
        usuario_id: created.user.id,
        auth_user_id: created.user.id,
        email,
        nombre,
        plaza,
        rol,
        estado,
        puede_activar: puedeActivar,
        lider_id: liderId,
        inhabilitado_at: estado === 'inhabilitado' ? new Date().toISOString() : null,
        motivo_inhabilitacion: estado === 'inhabilitado' ? motivoInhabilitacion : null,
      }
      if (esActivador && !teamId) insertedUser.organizacion_pendiente = true
      if (teamId) {
        insertedUser.equipo_id = teamId
        insertedUser.plaza_base = plaza
        if (teamPlazaId) {
          insertedUser.plaza_id = teamPlazaId
          insertedUser.organizacion_pendiente = false
        }
      }

      const { error: insertErr } = await adminSupabase.from('activadores').insert(insertedUser)

      if (insertErr) {
        await adminSupabase.auth.admin.deleteUser(created.user.id)
        jsonError(
          res,
          500,
          'No se pudo guardar el usuario en activadores. Se revirtio la creacion en Auth automaticamente.',
          insertErr.message
        )
        return
      }

      try {
        await syncUserRoles(created.user.id, roles)
      } catch (error) {
        const cleanupErrors = []
        try {
          const { error: cleanupError } = await adminSupabase.from('activadores').delete().eq('usuario_id', created.user.id)
          if (cleanupError) cleanupErrors.push(cleanupError.message)
        } catch (cleanupError) { cleanupErrors.push(cleanupError.message) }
        try {
          const { error: cleanupError } = await adminSupabase.auth.admin.deleteUser(created.user.id)
          if (cleanupError) cleanupErrors.push(cleanupError.message)
        } catch (cleanupError) { cleanupErrors.push(cleanupError.message) }
        jsonError(res, 500, cleanupErrors.length ? 'No se pudieron asignar roles; revisar limpieza del usuario.' : 'No se pudieron asignar roles; se elimino el usuario creado.',
          [error.message, ...cleanupErrors].join('; '))
        return
      }

      if (esLider && leaderOrganizationAvailable) {
        try {
          await syncLeaderTeams(created.user.id, requestedTeamIds)
        } catch (error) {
          await adminSupabase.from('activadores').delete().eq('usuario_id', created.user.id)
          await adminSupabase.auth.admin.deleteUser(created.user.id)
          jsonError(res, 409, 'No se pudieron asignar los equipos al lider.', error?.message)
          return
        }
      }

      if (esFacturador && billerOrganizationAvailable) {
        try {
          await syncFacturadorTeams(created.user.id, nombre, requestedBillerTeamIds, true)
        } catch (error) {
          await adminSupabase.from('activadores').delete().eq('usuario_id', created.user.id)
          await adminSupabase.auth.admin.deleteUser(created.user.id)
          jsonError(res, 409, 'No se pudieron asignar los equipos al facturador.', error?.message)
          return
        }
      }

      res.status(201).json({ user: { ...insertedUser, roles } })
    })
  )

  app.post(
    '/admin/users/:userId/reset-password',
    asyncRoute(async (req, res) => {
      const userId = normalizeText(req.params?.userId)
      const password = typeof req.body?.password === 'string' ? req.body.password : ''

      if (!userId) {
        jsonError(res, 400, 'Parametro userId requerido.')
        return
      }
      if (!isStrongPassword(password)) {
        jsonError(res, 400, 'La contrasena debe tener al menos 10 caracteres, mayuscula, minuscula, numero y simbolo.')
        return
      }

      const { data: targetProfile, error: targetProfileError } = await adminSupabase.from('activadores')
        .select('usuario_id,auth_user_id').eq('usuario_id', userId).maybeSingle()
      if (targetProfileError || !targetProfile) {
        jsonError(res, 404, 'No se encontro el usuario solicitado.')
        return
      }
      if (!targetProfile.auth_user_id) {
        jsonError(res, 409, 'El perfil no tiene cuenta de acceso para restablecer.')
        return
      }

      const { data: existingAuthUser, error: getUserError } = await adminSupabase.auth.admin.getUserById(targetProfile.auth_user_id)
      if (getUserError || !existingAuthUser?.user) {
        jsonError(res, 404, 'No se encontro el usuario solicitado.')
        return
      }

      const { error: updatePasswordError } = await adminSupabase.auth.admin.updateUserById(targetProfile.auth_user_id, { password })
      if (updatePasswordError) {
        jsonError(res, 500, 'No se pudo restablecer la contrasena.')
        return
      }

      res.json({ ok: true })
    })
  )

  app.get(
    '/admin/organization-options',
    asyncRoute(async (_req, res) => {
      try {
        res.json(await loadOrganizationOptions())
      } catch (error) {
        jsonError(res, 500, 'No se pudo cargar la estructura organizacional.', error?.message)
      }
    })
  )

  app.get('/admin/teams', asyncRoute(async (_req, res) => {
    const options = await loadOrganizationOptions()
    if (!options.available) { res.json(options); return }
    const { data: members, error } = await adminSupabase.from('activadores')
      .select('usuario_id,equipo_id').eq('rol', 'activador')
    if (error && !isMissingOrganizationSchema(error)) {
      jsonError(res, 500, 'No se pudo contar los integrantes.', error.message)
      return
    }
    const memberCount = new Map()
    for (const member of members ?? []) memberCount.set(member.equipo_id, (memberCount.get(member.equipo_id) ?? 0) + 1)
    res.json({ ...options, equipos: options.equipos.map((team) => ({ ...team, integrantes: memberCount.get(team.id) ?? 0 })) })
  }))

  app.get('/admin/teams/:teamId', asyncRoute(async (req, res) => {
    const teamId = normalizeText(req.params.teamId)
    const [{ data: members, error: membersError }, { data: history, error: historyError }] = await Promise.all([
      adminSupabase.from('activadores').select('usuario_id,nombre,email,estado,plaza,plaza_base').eq('equipo_id', teamId).eq('rol', 'activador').order('nombre'),
      adminSupabase.from('equipo_lider_historial').select('id,lider_id,inicio,fin,motivo').eq('equipo_id', teamId).order('inicio', { ascending: false }),
    ])
    const schemaError = membersError || historyError
    if (schemaError) {
      if (isMissingOrganizationSchema(schemaError)) {
        res.json({ available: false, message: 'El detalle de equipos estara disponible despues de habilitar el modelo organizacional.', integrantes: [], historial: [] })
        return
      }
      jsonError(res, 500, 'No se pudo cargar el detalle del equipo.', schemaError.message)
      return
    }
    res.json({ available: true, integrantes: members ?? [], historial: history ?? [] })
  }))

  app.post('/admin/teams', asyncRoute(async (req, res) => {
    const numero = Number(req.body?.numero)
    const nombre = normalizeText(req.body?.nombre) || INTERNAL_TEAM_NAME
    const plazaId = normalizeNullableText(req.body?.plaza_id)
    const liderId = normalizeNullableText(req.body?.lider_id)
    if (!Number.isSafeInteger(numero) || numero <= 0) {
      jsonError(res, 400, 'Número de equipo es obligatorio.')
      return
    }
    if (!plazaId) {
      jsonError(res, 400, 'Plaza es obligatoria.')
      return
    }
    const { data: duplicateTeam, error: duplicateError } = await adminSupabase.from('equipos')
      .select('id').eq('numero', numero).limit(1)
    if (duplicateError && isMissingOrganizationSchema(duplicateError)) {
      jsonError(res, 409, 'La gestion de equipos estara disponible cuando se habilite el modelo organizacional.')
      return
    }
    if (duplicateError) { jsonError(res, 500, 'No se pudo validar el numero de equipo.', duplicateError.message); return }
    if (duplicateTeam?.length) { jsonError(res, 409, 'Ya existe un equipo con ese numero.'); return }
    const { data: team, error } = await adminSupabase.from('equipos').insert({
      numero, nombre, plaza_id: plazaId, lider_actual_id: null, activo: true,
    }).select('*').single()
    if (error) {
      if (isMissingOrganizationSchema(error)) { jsonError(res, 409, 'La gestion de equipos estara disponible cuando se habilite el modelo organizacional.'); return }
      jsonError(res, 500, 'No se pudo crear el equipo.', error.message); return
    }
    if (liderId) {
      const { error: leaderError } = await adminSupabase.rpc('asignar_lider_equipo', { p_equipo_id: team.id, p_lider_id: liderId, p_motivo: 'Creacion administrativa de equipo' })
      if (leaderError) {
        await adminSupabase.from('equipos').delete().eq('id', team.id)
        jsonError(res, 409, 'No se pudo asignar el lider.', leaderError.message)
        return
      }
    }
    res.status(201).json({ team: { ...team, lider_actual_id: liderId } })
  }))

  app.patch('/admin/teams/:teamId', asyncRoute(async (req, res) => {
    const teamId = normalizeText(req.params.teamId)
    const numero = Number(req.body?.numero)
    const nombre = normalizeText(req.body?.nombre)
    const plazaId = normalizeNullableText(req.body?.plaza_id)
    const facturadorId = normalizeNullableText(req.body?.facturador_id)
    const liderId = normalizeNullableText(req.body?.lider_id)
    const activo = req.body?.activo
    if (!teamId || !Number.isSafeInteger(numero) || numero <= 0 || !nombre || typeof activo !== 'boolean') {
      jsonError(res, 400, 'Numero, nombre y estado son obligatorios.')
      return
    }
    const { data: duplicateTeam, error: duplicateError } = await adminSupabase.from('equipos')
      .select('id').eq('numero', numero).neq('id', teamId).limit(1)
    if (duplicateError && isMissingOrganizationSchema(duplicateError)) {
      jsonError(res, 409, 'La gestion de equipos estara disponible cuando se habilite el modelo organizacional.')
      return
    }
    if (duplicateError) { jsonError(res, 500, 'No se pudo validar el numero de equipo.', duplicateError.message); return }
    if (duplicateTeam?.length) { jsonError(res, 409, 'Ya existe un equipo con ese numero.'); return }
    const { error } = await adminSupabase.rpc('actualizar_equipo_organizacion', {
      p_equipo_id: teamId, p_numero: numero, p_nombre: nombre, p_plaza_id: plazaId,
      p_facturador_id: facturadorId, p_lider_id: liderId, p_activo: activo, p_inicio: new Date().toISOString(),
      p_motivo: 'Edicion administrativa de equipo',
    })
    if (error) {
      if (isMissingOrganizationSchema(error)) { jsonError(res, 409, 'La gestion de equipos estara disponible cuando se habilite el modelo organizacional.'); return }
      jsonError(res, error.code === '23P01' || error.code === '23505' ? 409 : 500, 'No se pudo actualizar el equipo.', error.message)
      return
    }
    res.json({ ok: true })
  }))

  app.delete('/admin/plazas/:plazaId', requireAdminReauthentication, asyncRoute(async (req, res) => {
    const plazaId = normalizeText(req.params.plazaId)
    if (!plazaId) { jsonError(res, 400, 'Parametro plazaId requerido.'); return }

    const { data: plaza, error: plazaErr } = await adminSupabase.from('plazas').select('*').eq('id', plazaId).maybeSingle()
    if (plazaErr) { jsonError(res, 500, 'No se pudo leer la plaza.', plazaErr.message); return }
    if (!plaza) { jsonError(res, 404, 'Plaza no encontrada.'); return }

    try {
      const relationChecks = await Promise.all([
        adminSupabase.from('equipos').select('id', { count: 'exact', head: true }).eq('plaza_id', plazaId),
        adminSupabase.from('activadores').select('usuario_id', { count: 'exact', head: true }).eq('plaza_id', plazaId),
        adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_id_registro', plazaId),
        adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_base_id_registro', plazaId),
        adminSupabase.from('activaciones').select('id', { count: 'exact', head: true }).eq('plaza_efectiva_id_registro', plazaId),
        adminSupabase.from('activador_plaza_temporal').select('id', { count: 'exact', head: true }).eq('plaza_temporal_id', plazaId),
      ])

      const failedCheck = relationChecks.find(({ error }) => error)
      if (failedCheck) {
        const err = failedCheck.error
        jsonError(res, 500, 'No se pudo verificar relaciones de la plaza.', err?.message)
        return
      }

      const hasRelations = relationChecks.some(({ count }) => (count ?? 0) > 0)

      if (hasRelations) {
        res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar la plaza porque tiene información relacionada. Puedes desactivarla.' })
        return
      }

      const { error: delErr } = await adminSupabase.from('plazas').delete().eq('id', plazaId)
      if (delErr) { jsonError(res, 500, 'No se pudo eliminar la plaza.', delErr.message); return }
      res.json({ ok: true, deleted: true, message: 'Plaza eliminada correctamente.' })
    } catch (err) {
      jsonError(res, 500, 'Error verificando relaciones de plaza.', err?.message ?? String(err))
    }
  }))

  app.post('/admin/plazas/:plazaId/reassign-delete', requireAdminReauthentication, asyncRoute(async (req, res) => {
    const plazaId = normalizeText(req.params.plazaId)
    const destinoId = normalizeText(req.body?.destino_id)
    if (!plazaId || !destinoId || plazaId === destinoId) { jsonError(res, 400, 'Plaza de destino invalida.'); return }
    const { data, error } = await adminSupabase.rpc('reasignar_y_eliminar_plaza', { p_plaza_origen: plazaId, p_plaza_destino: destinoId })
    if (error) { jsonError(res, error.code === 'P0001' || error.code === '23503' ? 409 : 500, error.code === 'P0001' || error.code === '23503' ? error.message : 'No se pudo reasignar y eliminar la plaza.', error.message); return }
    res.json({ ok: true, deleted: true, reassigned: data, message: 'Relaciones operativas reasignadas y plaza eliminada.' })
  }))

  app.delete('/admin/teams/:teamId', requireAdminReauthentication, asyncRoute(async (req, res) => {
    const teamId = normalizeText(req.params.teamId)
    if (!teamId) { jsonError(res, 400, 'Parametro teamId requerido.'); return }

    const { data: team, error: teamError } = await adminSupabase.from('equipos').select('*').eq('id', teamId).maybeSingle()
    if (teamError) { jsonError(res, 500, 'No se pudo leer el equipo.', teamError.message); return }
    if (!team) { jsonError(res, 404, 'Equipo no encontrado.'); return }

    const checks = await Promise.all([
      adminSupabase.from('activadores').select('usuario_id', { count: 'exact', head: true }).eq('equipo_id', teamId),
      adminSupabase.from('equipo_lider_historial').select('id', { count: 'exact', head: true }).eq('equipo_id', teamId),
    ])
    const failed = checks.find((item) => item.error)
    if (failed) { jsonError(res, 500, 'No se pudo verificar relaciones del equipo.', failed.error.message); return }
    if (checks.some((item) => (item.count ?? 0) > 0)) { res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar el equipo porque tiene integrantes o historial relacionado. Debe deshabilitarse.' }); return }

    // Siempre realizar baja lógica: inactivar el equipo para preservar historial y relaciones
    const { error: deleteErr } = await adminSupabase.from('equipos').delete().eq('id', teamId)
    if (deleteErr) { jsonError(res, deleteErr.code === '23503' ? 409 : 500, deleteErr.code === '23503' ? 'No se puede eliminar el equipo porque tiene información relacionada. Debe deshabilitarse.' : 'No se pudo eliminar el equipo.', deleteErr.message); return }
    res.json({ ok: true, deleted: true, message: 'Equipo eliminado correctamente.' })
  }))

  // Plazas: listar, crear, editar (activar/desactivar)
  app.get('/admin/plazas', asyncRoute(async (_req, res) => {
    const { data, error } = await adminSupabase.from('plazas').select('id,nombre,nombre_normalizado,activa').order('nombre')
    if (error) {
      if (isMissingOrganizationSchema(error)) { jsonError(res, 409, 'El modelo organizacional no esta habilitado.', error.message); return }
      jsonError(res, 500, 'No se pudo obtener las plazas.', error.message); return
    }
    res.json({ plazas: data ?? [] })
  }))

  app.post('/admin/plazas', asyncRoute(async (req, res) => {
    const nombre = normalizeText(req.body?.nombre)
    if (!nombre) { jsonError(res, 400, 'Nombre de plaza requerido.'); return }
    const nombre_normalizado = normalizeOrganizationName(nombre)
    try {
      const { data: existing, error: existingErr } = await adminSupabase.from('plazas').select('id').eq('nombre_normalizado', nombre_normalizado).maybeSingle()
      if (existingErr) { throw existingErr }
      if (existing) { jsonError(res, 409, 'Ya existe una plaza con ese nombre.'); return }
      const { data: created, error: createErr } = await adminSupabase.from('plazas').insert({ nombre, nombre_normalizado }).select('*').single()
      if (createErr) { throw createErr }
      res.status(201).json({ plaza: created })
    } catch (err) {
      if (isMissingOrganizationSchema(err)) { jsonError(res, 409, 'El modelo organizacional no esta habilitado.', err.message); return }
      jsonError(res, 500, 'No se pudo crear la plaza.', err.message)
    }
  }))

  app.patch('/admin/plazas/:plazaId', asyncRoute(async (req, res) => {
    const plazaId = normalizeText(req.params.plazaId)
    if (!plazaId) { jsonError(res, 400, 'Parametro plazaId requerido.'); return }
    const nombre = normalizeNullableText(req.body?.nombre)
    const activa = req.body?.activa
    const updates = {}
    if (nombre != null) updates.nombre = nombre
    if (typeof activa === 'boolean') updates.activa = activa
    if (Object.keys(updates).length === 0) { jsonError(res, 400, 'Nada que actualizar.'); return }
    if (updates.nombre) updates.nombre_normalizado = normalizeOrganizationName(updates.nombre)
    const { error } = await adminSupabase.from('plazas').update(updates).eq('id', plazaId)
    if (error) { jsonError(res, 500, 'No se pudo actualizar la plaza.', error.message); return }
    res.json({ ok: true })
  }))

  app.post(
    '/admin/users/:userId/temporary-plaza',
    asyncRoute(async (req, res) => {
      const userId = normalizeText(req.params?.userId)
      const plazaTemporal = normalizeText(req.body?.plaza_temporal)
      const inicio = new Date(req.body?.inicio)
      const fin = new Date(req.body?.fin)
      const motivo = normalizeText(req.body?.motivo)
      const tipoZona = normalizeText(req.body?.tipo_zona) || 'punto_temporal'
      const ciudadPlaza = normalizeNullableText(req.body?.ciudad_plaza)
      const activo = req.body?.activo !== false
      const authorizedBy = req.portalUser?.usuario_id
      if (!userId || !plazaTemporal || !motivo || Number.isNaN(inicio.getTime()) || Number.isNaN(fin.getTime()) || fin <= inicio) {
        jsonError(res, 400, 'activador, plaza temporal, inicio, fin y motivo validos son obligatorios.')
        return
      }
      if (!ALLOWED_TEMPORARY_ZONE_TYPES.has(tipoZona)) {
        jsonError(res, 400, 'tipo_zona invalido.')
        return
      }

      if (!authorizedBy) {
        jsonError(res, 400, 'La asignacion temporal requiere una sesion administrativa identificable.')
        return
      }
      const { data: user, error: userError } = await adminSupabase.from('activadores')
        .select('usuario_id,rol,estado').eq('usuario_id', userId).maybeSingle()
      if (userError || !user || user.rol !== 'activador' || user.estado !== 'activo') {
        jsonError(res, 400, 'La plaza temporal solo puede asignarse a un activador activo.', userError?.message)
        return
      }
      const temporaryPlazaId = await resolveOrCreatePlaza(plazaTemporal)
      const temporaryPayload = {
        activador_id: userId,
        plaza_temporal: plazaTemporal,
        inicio: inicio.toISOString(),
        fin: fin.toISOString(),
        motivo,
        tipo_zona: tipoZona,
        ciudad_plaza: ciudadPlaza,
        activo,
        autorizado_por: authorizedBy,
      }
      if (temporaryPlazaId) temporaryPayload.plaza_temporal_id = temporaryPlazaId
      const { data, error } = await adminSupabase.from('activador_plaza_temporal')
        .insert(temporaryPayload).select('*').single()
      if (error) {
        if (isMissingOrganizationSchema(error)) {
          jsonError(res, 409, 'La plaza temporal estara disponible cuando se habilite el modelo organizacional.')
          return
        }
        jsonError(res, error.code === '23P01' ? 409 : 500,
          error.code === '23P01' ? 'El periodo se solapa con otra plaza temporal.' : 'No se pudo asignar la plaza temporal.', error.message)
        return
      }
      res.status(201).json({ assignment: data })
    })
  )

  app.delete(
    '/admin/users/:userId/temporary-plaza',
    asyncRoute(async (req, res) => {
      const now = new Date().toISOString()
      const authorizedBy = req.portalUser?.usuario_id
      if (!authorizedBy) {
        jsonError(res, 400, 'La cancelacion requiere una sesion administrativa identificable.')
        return
      }
      const { error } = await adminSupabase.from('activador_plaza_temporal').update({
        cancelado_at: now,
        cancelado_por: authorizedBy,
      }).eq('activador_id', req.params.userId).is('cancelado_at', null).lte('inicio', now).gte('fin', now)
      if (error) {
        if (isMissingOrganizationSchema(error)) {
          jsonError(res, 409, 'No hay una asignacion temporal administrable en el esquema actual.')
          return
        }
        jsonError(res, 500, 'No se pudo cancelar la plaza temporal.', error.message)
        return
      }
      res.json({ ok: true })
    })
  )

  app.patch(
    '/admin/users/:userId',
    asyncRoute(async (req, res) => {
      const { userId } = req.params

      const rawNombre = req.body?.nombre
      const rawPlaza = req.body?.plaza
      const rawEmail = req.body?.email
      const rawEmailConfirm = req.body?.emailConfirm
      const rawPassword = req.body?.password
      const requestedTeamId = normalizeNullableText(req.body?.equipo_id)
      const requestedTeamIds = Array.isArray(req.body?.equipo_ids) ? req.body.equipo_ids : []
      const requestedBillerTeamIds = Array.isArray(req.body?.facturador_equipo_ids) ? req.body.facturador_equipo_ids : []
      const requestedRol = normalizeText(req.body?.rol)
      const requestedEstado = normalizeText(req.body?.estado)

      const nombre = normalizeText(rawNombre)
      let plaza = normalizeNullableText(rawPlaza)
      const shouldUpdateEmail = typeof rawEmail === 'string'
      const email = shouldUpdateEmail ? normalizeEmail(rawEmail) : null
      const emailConfirm = rawEmailConfirm === true
      const password = typeof rawPassword === 'string' ? rawPassword : ''

      if (!nombre) {
        jsonError(res, 400, 'nombre es obligatorio.')
        return
      }

      if (shouldUpdateEmail && !email) {
        jsonError(res, 400, 'email es obligatorio cuando se desea actualizar.')
        return
      }

      if (shouldUpdateEmail && !isValidEmail(email)) {
        jsonError(res, 400, 'email invalido.')
        return
      }

      if (password && !isStrongPassword(password)) {
        jsonError(res, 400, 'La contrasena debe tener al menos 10 caracteres, mayuscula, minuscula, numero y simbolo.')
        return
      }

      if ((requestedRol && !ALLOWED_USER_ROLES.has(requestedRol)) ||
        (requestedEstado && !ALLOWED_USER_STATES.has(requestedEstado))) {
        jsonError(res, 400, 'rol o estado invalido.')
        return
      }

      const { data: previousRow, error: previousRowErr } = await adminSupabase
        .from('activadores')
        .select('*')
        .eq('usuario_id', userId)
        .maybeSingle()

      if (previousRowErr) {
        jsonError(res, 500, previousRowErr.message)
        return
      }

      if (!previousRow) {
        jsonError(res, 404, 'No se encontro el usuario en la tabla activadores.')
        return
      }

      const previousEmail = normalizeEmail(previousRow.email) || null
      const emailChanged = shouldUpdateEmail && email !== previousEmail

      const { data: previousRoleRows, error: previousRolesError } = await adminSupabase
        .from('activador_roles').select('rol').eq('usuario_id', userId)
      if (previousRolesError) { jsonError(res, 500, previousRolesError.message); return }
      const previousRoles = (previousRoleRows ?? []).map((row) => row.rol)
      let roleSelection
      try { roleSelection = resolveUserRoles(req.body, previousRoles, previousRow.rol) }
      catch (error) { jsonError(res, 400, error.message); return }
      const { rol, roles } = roleSelection
      const esLider = roles.includes('lider')
      const esActivador = roles.includes('activador')
      const esFacturador = roles.includes('facturador')
      const estado = requestedEstado || previousRow.estado || 'activo'
      const puedeActivar = rol === 'lider' && (
        req.body?.puede_activar === undefined
          ? previousRow.puede_activar === true
          : req.body.puede_activar === true
      )
      let liderId = esActivador
        ? (req.body?.lider_id === undefined ? previousRow.lider_id : normalizeNullableText(req.body.lider_id))
        : null
      const motivoInhabilitacion = req.body?.motivo_inhabilitacion === undefined
        ? normalizeNullableText(previousRow.motivo_inhabilitacion)
        : normalizeNullableText(req.body.motivo_inhabilitacion)

      if (estado === 'inhabilitado' && !motivoInhabilitacion) {
        jsonError(res, 400, 'El motivo de inhabilitacion es obligatorio.')
        return
      }

      let teamId = null
      let teamPlazaId = null
      if (esActivador) {
        const options = await loadOrganizationOptions()
        if (options.available && requestedTeamId) {
          const selectedTeam = options.equipos.find((team) => team.id === requestedTeamId && team.activo)
          const selectedPlaza = options.plazas.find((item) => item.id === selectedTeam?.plaza_id)
          if (!selectedTeam || !selectedPlaza) {
            jsonError(res, 400, 'El equipo seleccionado debe estar activo y tener una plaza valida.')
            return
          }
          teamId = selectedTeam.id
          teamPlazaId = selectedTeam.plaza_id
          liderId = selectedTeam.lider_actual_id ?? null
          plaza = selectedPlaza.nombre
        }
      }

      if (liderId && !teamId) {
        const { data: leader, error: leaderErr } = await adminSupabase
          .from('activadores')
          .select('usuario_id')
          .eq('usuario_id', liderId)
          .eq('estado', 'activo')
          .maybeSingle()
        const { data: leaderRole, error: leaderRoleErr } = await adminSupabase.from('activador_roles')
          .select('usuario_id').eq('usuario_id', liderId).eq('rol', 'lider').maybeSingle()
        if (leaderErr || !leader || leaderRoleErr || !leaderRole) {
          jsonError(res, 400, 'lider_id debe corresponder a un lider activo.', leaderErr?.message ?? leaderRoleErr?.message)
          return
        }
      }

      let leaderOrganizationAvailable = false
      const shouldSyncLeaderTeams = esLider || (previousRoles.length ? previousRoles.includes('lider') : previousRow.rol === 'lider')
      if (shouldSyncLeaderTeams) {
        const options = await loadOrganizationOptions()
        leaderOrganizationAvailable = options.available
        if (options.available) {
          const effectiveTeamIds = esLider ? requestedTeamIds : []

          const selectedTeams = options.equipos.filter((team) => effectiveTeamIds.includes(team.id))
          if (selectedTeams.length !== new Set(effectiveTeamIds).size) {
            jsonError(res, 409, 'La asignacion de equipos del lider no es valida.')
            return
          }
        }
      }

      const hadFacturadorRole = previousRoles.length
        ? previousRoles.includes('facturador')
        : previousRow.rol === 'facturador'
      const shouldSyncBillerTeams = esFacturador || hadFacturadorRole
      let billerOrganizationAvailable = false
      if (shouldSyncBillerTeams) {
        const options = await loadOrganizationOptions()
        billerOrganizationAvailable = options.available
        if (options.available && esFacturador) {
          const selectedTeams = options.equipos.filter((team) => requestedBillerTeamIds.includes(team.id) && team.activo)
          if (selectedTeams.length !== new Set(requestedBillerTeamIds).size) {
            jsonError(res, 409, 'La asignacion de equipos del facturador no es valida.')
            return
          }
        }
      }

      const tableUpdatePayload = {
        nombre,
        plaza,
        rol,
        estado,
        puede_activar: puedeActivar,
        lider_id: liderId,
        inhabilitado_at: estado === 'inhabilitado'
          ? previousRow.inhabilitado_at || new Date().toISOString()
          : null,
        motivo_inhabilitacion: estado === 'inhabilitado' ? motivoInhabilitacion : null,
      }
      if (esActivador && !teamId && req.body?.equipo_id === undefined) teamId = await resolveTeamIdForLeader(liderId, plaza)
      if (teamId) {
        tableUpdatePayload.equipo_id = teamId
        tableUpdatePayload.plaza_base = plaza
        if (teamPlazaId) {
          tableUpdatePayload.plaza_id = teamPlazaId
          tableUpdatePayload.organizacion_pendiente = false
        }
      }
      if (esActivador && !teamId && req.body?.equipo_id === undefined && previousRow.equipo_id) {
        teamId = previousRow.equipo_id
      }
      if ((!esActivador || !teamId) && Object.prototype.hasOwnProperty.call(previousRow, 'equipo_id')) {
        tableUpdatePayload.equipo_id = null
        if (Object.prototype.hasOwnProperty.call(previousRow, 'plaza_id')) tableUpdatePayload.plaza_id = null
        if (Object.prototype.hasOwnProperty.call(previousRow, 'organizacion_pendiente')) tableUpdatePayload.organizacion_pendiente = esActivador
      }
      if (shouldUpdateEmail) {
        tableUpdatePayload.email = email
      }

      const { error: updateTableErr } = await adminSupabase
        .from('activadores')
        .update(tableUpdatePayload)
        .eq('usuario_id', userId)

      if (updateTableErr) {
        jsonError(res, 500, updateTableErr.message)
        return
      }

      async function rollbackUserUpdate() {
        const rollbackPayload = {
            nombre: previousRow.nombre,
            plaza: previousRow.plaza,
            email: previousRow.email ?? null,
            rol: previousRow.rol,
            estado: previousRow.estado,
            puede_activar: previousRow.puede_activar,
            lider_id: previousRow.lider_id,
            inhabilitado_at: previousRow.inhabilitado_at,
            motivo_inhabilitacion: previousRow.motivo_inhabilitacion,
          }
        if (Object.prototype.hasOwnProperty.call(previousRow, 'equipo_id')) rollbackPayload.equipo_id = previousRow.equipo_id
        if (Object.prototype.hasOwnProperty.call(previousRow, 'plaza_base')) rollbackPayload.plaza_base = previousRow.plaza_base
        if (Object.prototype.hasOwnProperty.call(previousRow, 'plaza_id')) rollbackPayload.plaza_id = previousRow.plaza_id
        if (Object.prototype.hasOwnProperty.call(previousRow, 'organizacion_pendiente')) rollbackPayload.organizacion_pendiente = previousRow.organizacion_pendiente
        const errors = []
        try {
          const { error: rollbackError } = await adminSupabase
            .from('activadores').update(rollbackPayload).eq('usuario_id', userId)
          if (rollbackError) errors.push(rollbackError.message)
        } catch (error) { errors.push(error.message) }
        try { await syncUserRoles(userId, previousRoles) }
        catch (error) { errors.push(error.message) }
        return errors
      }

      try {
        await syncUserRoles(userId, roles)
      } catch (error) {
        let rollbackErrors
        try { rollbackErrors = await rollbackUserUpdate() }
        catch (rollbackError) { rollbackErrors = [rollbackError.message] }
        jsonError(res, 500, rollbackErrors.length ? 'No se pudieron sincronizar roles; rollback incompleto.' : 'No se pudieron sincronizar roles; cambios revertidos.',
          [error.message, ...rollbackErrors].join('; '))
        return
      }

      const authUpdatePayload = {
        user_metadata: { nombre, plaza },
      }

      if (emailConfirm) {
        authUpdatePayload.email_confirm = true
      }

      if (password) {
        authUpdatePayload.password = password
      }

      if (emailChanged) {
        authUpdatePayload.email = email
        if (!emailConfirm) {
          authUpdatePayload.email_confirm = true
        }
      }

      let updateAuthErr
      const authIdForUpdate = previousRow.auth_user_id ?? null
      if (!authIdForUpdate && (password || emailChanged)) {
        jsonError(res, 409, 'El perfil no tiene cuenta de acceso para actualizar credenciales.')
        return
      }
      try {
        if (!authIdForUpdate) {
          updateAuthErr = null
        } else {
          const result = await adminSupabase.auth.admin.updateUserById(authIdForUpdate, authUpdatePayload)
          updateAuthErr = result.error
        }
      } catch (error) { updateAuthErr = error }

      if (updateAuthErr) {
        let rollbackErrors
        try { rollbackErrors = await rollbackUserUpdate() }
        catch (error) { rollbackErrors = [error.message] }

        jsonError(
          res,
          500,
          'No se pudo actualizar Auth. Se intento revertir el cambio en tabla para mantener consistencia.',
          [updateAuthErr.message, ...rollbackErrors].join('; ')
        )
        return
      }

      if (shouldSyncLeaderTeams) {
        try {
          if (leaderOrganizationAvailable) {
            await syncLeaderTeams(userId, esLider ? requestedTeamIds : [])
          }
        } catch (error) {
          jsonError(res, 409, 'El usuario se actualizo, pero no se pudieron actualizar sus equipos.', error?.message)
          return
        }
      }

      if (shouldSyncBillerTeams && billerOrganizationAvailable) {
        try {
          await syncFacturadorTeams(userId, nombre, esFacturador ? requestedBillerTeamIds : [], esFacturador)
        } catch (error) {
          jsonError(res, 409, 'El usuario se actualizo, pero no se pudieron actualizar sus equipos facturados.', error?.message)
          return
        }
      }

      res.json({
        ok: true,
        rol,
        roles,
        emailUpdated: emailChanged,
        passwordUpdated: Boolean(password),
      })
    })
  )

  app.patch(
    '/admin/users/:userId/status',
    asyncRoute(async (req, res) => {
      const { userId } = req.params
      const estado = normalizeText(req.body?.estado)
      const motivo = normalizeNullableText(req.body?.motivo_inhabilitacion)

      if (!ALLOWED_USER_STATES.has(estado)) {
        jsonError(res, 400, 'estado invalido.')
        return
      }
      if (estado === 'inhabilitado' && !motivo) {
        jsonError(res, 400, 'El motivo de inhabilitacion es obligatorio.')
        return
      }

      const payload = {
        estado,
        inhabilitado_at: estado === 'inhabilitado' ? new Date().toISOString() : null,
        motivo_inhabilitacion: estado === 'inhabilitado' ? motivo : null,
      }
      const { data, error } = await adminSupabase
        .from('activadores')
        .update(payload)
        .eq('usuario_id', userId)
        .select('usuario_id')

      if (error) {
        jsonError(res, 500, 'No se pudo cambiar el estado del usuario.', error.message)
        return
      }
      if (!data?.length) {
        jsonError(res, 404, 'No se encontro el usuario en activadores.')
        return
      }
      res.json({ ok: true, ...payload })
    })
  )

  app.put(
    '/admin/activaciones/:activacionId/fotos/:tipo',
    parseActivationPhotoBody,
    asyncRoute(async (req, res) => {
      if (req.portalUser?.rol !== 'administrador') {
        jsonError(res, 403, 'Se requiere un administrador autenticado.')
        return
      }

      const activacionId = normalizeText(req.params?.activacionId)
      const tipo = normalizeText(req.params?.tipo).toLowerCase()
      const fieldByType = { principal: 'foto_url', 'cash-in': 'foto_cash_in' }
      const photoField = fieldByType[tipo]
      const mimeType = normalizeText(req.headers['content-type']).split(';')[0].toLowerCase()
      const extension = ACTIVATION_PHOTO_TYPES[mimeType]

      if (!activacionId) {
        jsonError(res, 400, 'Parametro activacionId requerido.')
        return
      }
      if (!photoField) {
        jsonError(res, 400, 'Tipo de foto invalido.')
        return
      }
      if (!extension || !isValidActivationPhotoBuffer(req.body, mimeType)) {
        jsonError(res, 415, 'La foto debe ser JPEG, PNG o WebP valido.')
        return
      }
      if (req.body.length > ACTIVATION_PHOTO_MAX_BYTES) {
        jsonError(res, 413, 'La foto excede el limite de 10 MB.')
        return
      }

      const { data: existingRow, error: existingError } = await adminSupabase
        .from('activaciones')
        .select('id,foto_url,foto_cash_in')
        .eq('id', activacionId)
        .maybeSingle()
      if (existingError) {
        jsonError(res, 500, 'No se pudo leer la activacion.', existingError)
        return
      }
      if (!existingRow?.id) {
        jsonError(res, 404, 'No se encontro la activacion indicada.')
        return
      }

      const newObjectPath = `portal-reemplazos/${photoField}/${crypto.randomUUID()}.${extension}`
      const { error: uploadError } = await adminSupabase.storage
        .from(activacionesBucket)
        .upload(newObjectPath, req.body, { contentType: mimeType, upsert: false })
      if (uploadError) {
        jsonError(res, 500, 'No se pudo guardar la nueva foto.', uploadError)
        return
      }

      const { data: updatedRow, error: updateError } = await adminSupabase
        .from('activaciones')
        .update({ [photoField]: newObjectPath })
        .eq('id', activacionId)
        .select('*')
        .maybeSingle()
      if (updateError || !updatedRow?.id) {
        const { error: cleanupError } = await adminSupabase.storage
          .from(activacionesBucket)
          .remove([newObjectPath])
        if (cleanupError) console.error('[admin-api] No se pudo limpiar una foto nueva sin referencia.', sanitizeLogDetails(cleanupError))
        jsonError(res, updateError ? 500 : 404, updateError ? 'No se pudo actualizar la activacion.' : 'No se encontro la activacion indicada.', updateError)
        return
      }

      const previousObjectPath = resolveStorageObjectPathFromFotoUrl(
        existingRow[photoField],
        activacionesBucket
      )
      let warning = null
      if (previousObjectPath && previousObjectPath !== newObjectPath) {
        const { error: removePreviousError } = await adminSupabase.storage
          .from(activacionesBucket)
          .remove([previousObjectPath])
        if (removePreviousError) {
          warning = 'La foto fue reemplazada, pero no se pudo eliminar el archivo anterior.'
          console.error('[admin-api] No se pudo eliminar una foto reemplazada.', sanitizeLogDetails(removePreviousError))
        }
      }

      let activation
      try {
        const signedRows = await attachActivationSignedPhotos(adminSupabase, activacionesBucket, [updatedRow])
        activation = signedRows[0]
      } catch (signedUrlError) {
        activation = {
          ...updatedRow,
          foto_url_signed: null,
          foto_cash_in_signed: null,
        }
        warning = [warning, 'La foto fue reemplazada, pero su enlace seguro no esta disponible temporalmente.']
          .filter(Boolean)
          .join(' ')
        console.error('[admin-api] No se pudo generar el enlace seguro de una foto reemplazada.', sanitizeLogDetails(signedUrlError))
      }

      res.json({ ok: true, activation, warning })
    })
  )

  app.patch(
    '/admin/activaciones/:activacionId',
    asyncRoute(async (req, res) => {
      const activacionId = normalizeText(req.params?.activacionId)
      const editReason = normalizeText(req.body?.motivoEdicion)
      const activationCategory = normalizeText(req.body?.categoriaActivacion)
      const changes = req.body?.changes
      const unexpectedBodyFields = Object.keys(req.body ?? {}).filter(
        (key) => !['changes', 'motivoEdicion', 'categoriaActivacion'].includes(key)
      )

      if (!activacionId) {
        jsonError(res, 400, 'Parametro activacionId requerido.')
        return
      }
      if (!editReason) {
        jsonError(res, 400, 'El motivo de edicion es obligatorio.')
        return
      }
      if (unexpectedBodyFields.length) {
        jsonError(res, 400, `Campos de solicitud no permitidos: ${unexpectedBodyFields.join(', ')}.`)
        return
      }
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        jsonError(res, 400, 'changes debe ser un objeto con los campos a modificar.')
        return
      }

      const changeKeys = Object.keys(changes)
      const forbiddenFields = changeKeys.filter((key) => !ACTIVATION_EDITABLE_FIELDS.has(key))
      if (forbiddenFields.length) {
        jsonError(res, 400, `Campos no permitidos: ${forbiddenFields.join(', ')}.`)
        return
      }
      if (!changeKeys.length) {
        jsonError(res, 400, 'No se enviaron cambios para guardar.')
        return
      }

      const updatePayload = {}
      for (const key of changeKeys) {
        if (['comercio_fuera_mercado', 'es_plaza_temporal', 'descargo_app', 'registro', 'cash_in',
          'cash_out', 'p2p', 'qr_fisico', 'respaldo', 'creditos', 'remesas', 'hubo_error'].includes(key)) {
          if (key === 'comercio_fuera_mercado' && changes[key] === null) {
            updatePayload[key] = null
          } else if (typeof changes[key] !== 'boolean') {
            jsonError(res, 400, `${key} debe ser booleano.`)
            return
          } else {
            updatePayload[key] = changes[key]
          }
        } else {
          updatePayload[key] = normalizeNullableText(changes[key])
        }
      }

      if (updatePayload.email_cliente && !isValidEmail(updatePayload.email_cliente)) {
        jsonError(res, 400, 'El correo del cliente no es valido.')
        return
      }
      if (updatePayload.telefono_cliente && !/^\+?[0-9\s()\-]{6,20}$/.test(updatePayload.telefono_cliente)) {
        jsonError(res, 400, 'El telefono no tiene un formato valido.')
        return
      }
      if (updatePayload.tamano_tienda && !ALLOWED_STORE_SIZES.has(updatePayload.tamano_tienda)) {
        jsonError(res, 400, 'tamano_tienda debe ser Pequeña, Mediana o Grande.')
        return
      }
      const textLengthError = validateActivationTextLengths(updatePayload)
      if (textLengthError) {
        jsonError(res, 400, textLengthError)
        return
      }

      const { data: existingRow, error: existingErr } = await adminSupabase
        .from('activaciones')
        .select('*')
        .eq('id', activacionId)
        .maybeSingle()
      if (existingErr) {
        jsonError(res, 500, 'No se pudo leer la activacion.', existingErr.message)
        return
      }
      if (!existingRow?.id) {
        jsonError(res, 404, 'No se encontro la activacion indicada.')
        return
      }

      const classificationKeys = new Set([
        'tipo_activacion', 'tamano_tienda', 'tipo_tienda', 'tipo_comercio',
        'rubro_comercio', 'rubro_comercio_otro', 'comercio_fuera_mercado',
      ])
      if (changeKeys.some((key) => classificationKeys.has(key))) {
        const normalizedClassification = normalizeActivationClassification({
          ...existingRow,
          ...updatePayload,
          tipo_grupo: activationCategory,
        }, existingRow)
        const classificationError = validateActivationClassification(normalizedClassification, existingRow)
        if (classificationError) {
          jsonError(res, 400, classificationError)
          return
        }
        Object.assign(updatePayload, activationClassificationUpdate(normalizedClassification))
      }

      const eligibilityRow = {
        ...existingRow,
        ...updatePayload,
        tipo_grupo: activationCategory || existingRow.tipo_grupo,
      }
      if (updatePayload.creditos === true && !isCreditosEligible(eligibilityRow)) {
        jsonError(res, 400, 'Créditos no aplica al tipo de activación seleccionado.')
        return
      }
      if (updatePayload.remesas === true && !isRemesasEligible(eligibilityRow)) {
        jsonError(res, 400, 'Remesas no aplica al tipo de activación seleccionado.')
        return
      }

      const actualUpdatePayload = Object.fromEntries(
        Object.entries(updatePayload).filter(([key, value]) => {
          const previousValue = existingRow[key] === '' ? null : existingRow[key]
          return previousValue !== value
        })
      )
      const actualChangeKeys = Object.keys(actualUpdatePayload)
      if (!actualChangeKeys.length) {
        jsonError(res, 400, 'No hay cambios nuevos para guardar.')
        return
      }

      const mergedRow = { ...existingRow, ...actualUpdatePayload }
      if (mergedRow.es_plaza_temporal === true && !normalizeText(mergedRow.plaza_temporal)) {
        jsonError(res, 400, 'plaza_temporal es obligatoria para una plaza temporal.')
        return
      }
      if (normalizeText(mergedRow.rubro_comercio).toLowerCase() === 'otro' &&
        !normalizeText(mergedRow.rubro_comercio_otro)) {
        jsonError(res, 400, 'rubro_comercio_otro es obligatorio cuando el rubro es Otro.')
        return
      }
      if (mergedRow.hubo_error === true && !normalizeText(mergedRow.tipo_error)) {
        jsonError(res, 400, 'tipo_error es obligatorio cuando hubo_error es verdadero.')
        return
      }
      if (mergedRow.hubo_error === true && normalizeText(mergedRow.tipo_error) === 'Otro' &&
        !normalizeText(mergedRow.descripcion_error)) {
        jsonError(res, 400, 'descripcion_error es obligatoria cuando tipo_error es Otro.')
        return
      }

      const { data: updatedRow, error: updateErr } = await adminSupabase
        .from('activaciones')
        .update(actualUpdatePayload)
        .eq('id', activacionId)
        .select('*')
        .maybeSingle()
      if (updateErr) {
        jsonError(res, 500, 'No se pudo actualizar la activacion.', updateErr.message)
        return
      }
      if (!updatedRow?.id) {
        jsonError(res, 404, 'No se encontro la activacion al guardar los cambios.')
        return
      }

      console.info('[admin-api] Activacion editada', {
        activacionId,
        camposModificados: actualChangeKeys,
        fecha: new Date().toISOString(),
      })
      res.json({ activation: updatedRow })
    })
  )

  app.delete(
    '/admin/users/:userId',
    requireAdminReauthentication,
    asyncRoute(async (req, res) => {
      const { userId } = req.params

      const { data: existingRow, error: existingErr } = await adminSupabase
        .from('activadores')
        .select('usuario_id, auth_user_id, email, nombre, estado, motivo_inhabilitacion')
        .eq('usuario_id', userId)
        .maybeSingle()

      if (existingErr) {
        jsonError(res, 500, existingErr.message)
        return
      }
      if (!existingRow) { jsonError(res, 404, 'No se encontro el usuario en activadores.'); return }
      if ((existingRow.estado ?? 'activo') !== 'inhabilitado') {
        res.status(409).json({ ok: false, deleted: false, message: 'El usuario esta activo. Debe inhabilitarse antes de eliminar su cuenta de acceso.' })
        return
      }

      const now = new Date().toISOString()
      const checks = await Promise.all([
        adminSupabase.from('activadores').select('usuario_id', { count: 'exact', head: true }).eq('lider_id', userId),
        adminSupabase.from('equipos').select('id', { count: 'exact', head: true }).eq('lider_actual_id', userId),
        adminSupabase.from('activador_plaza_temporal').select('id', { count: 'exact', head: true }).eq('activador_id', userId).lte('inicio', now).gte('fin', now).eq('activo', true).is('cancelado_at', null),
      ])
      const failedCheck = checks.find((item) => item.error)
      if (failedCheck) { jsonError(res, 500, 'No se pudo verificar relaciones activas del usuario.', failedCheck.error.message); return }
      const [lideradosCount, equiposLideradosCount, plazasVigentesCount] = checks.map((item) => item.count ?? 0)
      if (lideradosCount > 0) { res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar la cuenta porque el usuario tiene activadores a su cargo. Reasignelos antes de continuar.' }); return }
      if (equiposLideradosCount > 0) { res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar la cuenta porque el usuario lidera equipos vigentes. Libere el liderazgo antes de continuar.' }); return }
      if (plazasVigentesCount > 0) { res.status(409).json({ ok: false, deleted: false, message: 'No se puede eliminar la cuenta porque el usuario tiene una plaza temporal vigente. Cancelela antes de continuar.' }); return }

      if (!existingRow.auth_user_id) {
        res.json({ ok: true, deleted: true, authDeleted: false, cuentaAccesoEliminada: true, estado: 'inhabilitado', message: 'La cuenta de acceso ya estaba eliminada. El perfil y el historial se conservan como Inhabilitado.' })
        return
      }

      const { error: authDeleteError } = await adminSupabase.auth.admin.deleteUser(existingRow.auth_user_id)
      if (authDeleteError) {
        const alreadyMissing = /user not found/i.test(authDeleteError.message ?? '')
        if (!alreadyMissing) { jsonError(res, 500, 'No se pudo eliminar la cuenta de acceso.', authDeleteError.message); return }
      }

      const { data: profileAfter, error: profileAfterError } = await adminSupabase
        .from('activadores')
        .select('usuario_id, auth_user_id, estado')
        .eq('usuario_id', userId)
        .maybeSingle()
      if (profileAfterError || !profileAfter) {
        jsonError(res, 500, 'La cuenta se elimino pero no se pudo verificar el perfil historico.', profileAfterError?.message)
        return
      }

      res.json({ ok: true, deleted: true, authDeleted: true, cuentaAccesoEliminada: profileAfter.auth_user_id == null, estado: 'inhabilitado', message: 'Cuenta de acceso eliminada permanentemente. El perfil y el historial se conservan como Inhabilitado.' })
    })
  )

  app.get(
    '/admin/storage/summary',
    asyncRoute(async (_req, res) => {
      const { count: activacionesCount, error: activacionesCountErr } = await adminSupabase
        .from('activaciones')
        .select('id', { count: 'exact', head: true })

      if (activacionesCountErr) {
        jsonError(res, 500, 'No se pudo obtener conteo de activaciones.', activacionesCountErr.message)
        return
      }

      const { count: activacionesWithPhotoCount, error: activacionesWithPhotoCountErr } =
        await adminSupabase
          .from('activaciones')
          .select('id', { count: 'exact', head: true })
          .not('foto_url', 'is', null)
          .neq('foto_url', '')

      if (activacionesWithPhotoCountErr) {
        jsonError(
          res,
          500,
          'No se pudo obtener conteo de activaciones con foto.',
          activacionesWithPhotoCountErr.message
        )
        return
      }

      let bucketUsage = null
      try {
        bucketUsage = await calculateBucketUsageBytes(adminSupabase, activacionesBucket)
      } catch (error) {
        jsonError(
          res,
          500,
          'No se pudo calcular uso del bucket de fotos.',
          error instanceof Error ? error.message : undefined
        )
        return
      }

      let databaseSizeBytes = null
      let databaseSizeUnavailableReason = null

      const { data: databaseSizeData, error: databaseSizeErr } = await adminSupabase.rpc(
        'get_database_size_bytes'
      )

      if (databaseSizeErr) {
        databaseSizeUnavailableReason = databaseSizeErr.message
      } else if (typeof databaseSizeData === 'number') {
        databaseSizeBytes = databaseSizeData
      } else if (typeof databaseSizeData === 'string') {
        const parsedSize = Number(databaseSizeData)
        if (Number.isFinite(parsedSize) && parsedSize >= 0) {
          databaseSizeBytes = parsedSize
        }
      } else if (databaseSizeData && typeof databaseSizeData === 'object') {
        const candidate =
          databaseSizeData.get_database_size_bytes ??
          databaseSizeData.database_size_bytes ??
          databaseSizeData.size_bytes ??
          null
        const parsedSize = Number(candidate)
        if (Number.isFinite(parsedSize) && parsedSize >= 0) {
          databaseSizeBytes = parsedSize
        }
      }

      let estimatedDatabase = null
      let estimationUnavailableReason = null
      try {
        estimatedDatabase = await estimateDatabaseUsageFromActivaciones(adminSupabase, {
          activacionesCount: activacionesCount ?? 0,
          databaseLimitBytes,
        })
      } catch (error) {
        estimationUnavailableReason = error instanceof Error ? error.message : null
      }

      const storageRemainingBytes =
        storageLimitBytes == null ? null : Math.max(0, storageLimitBytes - bucketUsage.totalBytes)
      const storageUsagePercent =
        storageLimitBytes == null || storageLimitBytes <= 0
          ? null
          : Number(((bucketUsage.totalBytes / storageLimitBytes) * 100).toFixed(2))

      const effectiveDatabaseUsedBytes =
        databaseSizeBytes ?? estimatedDatabase?.estimated_database_used_bytes ?? null
      const databaseRemainingBytes =
        databaseLimitBytes == null || effectiveDatabaseUsedBytes == null
          ? null
          : Math.max(0, databaseLimitBytes - effectiveDatabaseUsedBytes)
      const databaseUsagePercent =
        databaseLimitBytes == null || databaseLimitBytes <= 0 || effectiveDatabaseUsedBytes == null
          ? null
          : Number(((effectiveDatabaseUsedBytes / databaseLimitBytes) * 100).toFixed(2))

      const perActivationDatabaseBytes =
        estimatedDatabase?.per_activation_estimated_bytes > 0
          ? estimatedDatabase.per_activation_estimated_bytes
          : Number(activacionesCount ?? 0) > 0 && effectiveDatabaseUsedBytes != null
            ? Math.max(1, Math.round(effectiveDatabaseUsedBytes / Number(activacionesCount ?? 0)))
            : null

      const combinedCapacityEstimation = estimateCombinedActivationCapacity({
        activacionesCount: activacionesCount ?? 0,
        activacionesWithPhotoCount: activacionesWithPhotoCount ?? 0,
        storageObjectsCount: bucketUsage.totalObjects,
        storageUsedBytes: bucketUsage.totalBytes,
        storageRemainingBytes,
        databaseRemainingBytes,
        perActivationDatabaseBytes,
      })

      res.json({
        summary: {
          bucket: activacionesBucket,
          activaciones_count: activacionesCount ?? 0,
          activaciones_with_photo_count: activacionesWithPhotoCount ?? 0,
          storage_objects_count: bucketUsage.totalObjects,
          storage_used_bytes: bucketUsage.totalBytes,
          storage_limit_bytes: storageLimitBytes,
          storage_limit_source: storageLimitSource,
          storage_remaining_bytes: storageRemainingBytes,
          storage_usage_percent: storageUsagePercent,
          database_size_bytes: databaseSizeBytes,
          database_used_effective_bytes: effectiveDatabaseUsedBytes,
          database_limit_bytes: databaseLimitBytes,
          database_limit_source: databaseLimitSource,
          database_remaining_bytes: databaseRemainingBytes,
          database_usage_percent: databaseUsagePercent,
          database_size_source:
            databaseSizeBytes == null
              ? estimatedDatabase
                ? 'estimate:activaciones_avg_row'
                : null
              : 'rpc:get_database_size_bytes',
          database_size_unavailable_reason:
            databaseSizeBytes == null ? databaseSizeUnavailableReason : null,
          database_estimation: estimatedDatabase,
          database_estimation_unavailable_reason:
            estimatedDatabase == null ? estimationUnavailableReason : null,
          combined_capacity_estimation: combinedCapacityEstimation,
          plan_reference: SUPABASE_FREE_PLAN_REFERENCE,
        },
      })
    })
  )

  app.delete(
    '/admin/activaciones/:activacionId',
    requireAdminReauthentication,
    asyncRoute(async (req, res) => {
      const activacionId = normalizeText(req.params?.activacionId)
      if (!activacionId) {
        jsonError(res, 400, 'Parametro activacionId requerido.')
        return
      }

      const { data: existingRow, error: existingRowErr } = await adminSupabase
        .from('activaciones')
        .select('id, foto_url, foto_cash_in')
        .eq('id', activacionId)
        .maybeSingle()

      if (existingRowErr) {
        jsonError(res, 500, 'No se pudo leer la activacion.', existingRowErr.message)
        return
      }

      if (!existingRow?.id) {
        jsonError(res, 404, 'No se encontro la activacion indicada.')
        return
      }

      const storageObjectPaths = [...new Set(
        [existingRow.foto_url, existingRow.foto_cash_in]
          .map((value) => resolveStorageObjectPathFromFotoUrl(value, activacionesBucket))
          .filter(Boolean)
      )]

      const { data: deletedRows, error: deleteActivationErr } = await adminSupabase
        .from('activaciones')
        .delete()
        .eq('id', activacionId)
        .select('id')

      if (deleteActivationErr) {
        jsonError(res, 500, 'No se pudo eliminar la activacion.', deleteActivationErr.message)
        return
      }

      const deletedActivation = Array.isArray(deletedRows) && deletedRows.length > 0
      if (!deletedActivation) {
        jsonError(res, 404, 'No se encontro la activacion indicada para eliminar.')
        return
      }

      const photoDelete = {
        attempted: storageObjectPaths.length > 0,
        ok: true,
        bucket: activacionesBucket,
        object_paths: storageObjectPaths,
        message: storageObjectPaths.length
          ? 'Fotos eliminadas correctamente.'
          : 'La activacion no tenia fotos asociadas.',
      }

      if (storageObjectPaths.length) {
        const { error: removePhotoErr } = await adminSupabase.storage
          .from(activacionesBucket)
          .remove(storageObjectPaths)

        if (removePhotoErr) {
          photoDelete.ok = false
          photoDelete.message = removePhotoErr.message
        }
      }

      if (!photoDelete.ok) {
        res.json({
          ok: true,
          warning:
            'La activacion se elimino, pero no fue posible borrar la foto del almacenamiento.',
          deleted_activation: true,
          photoDelete,
        })
        return
      }

      res.json({
        ok: true,
        deleted_activation: true,
        photoDelete,
      })
    })
  )

  app.get(
    '/admin/notifications',
    asyncRoute(async (req, res) => {
      const limit = parseLimit(req.query?.limit, { fallback: 60, min: 1, max: 300 })

      let { data: notifications, error: notificationsErr } = await adminSupabase
        .from('notificaciones')
        .select('id, titulo, mensaje, alcance, usuario_objetivo_id, tipo_audiencia, rol_objetivo, destinatarios_total, creado_por, created_at')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (notificationsErr && isMissingOrganizationSchema(notificationsErr)) {
        const legacyResult = await adminSupabase.from('notificaciones')
          .select('id, titulo, mensaje, alcance, usuario_objetivo_id, creado_por, created_at')
          .order('created_at', { ascending: false }).limit(limit)
        notifications = legacyResult.data
        notificationsErr = legacyResult.error
      }

      if (notificationsErr) {
        jsonError(
          res,
          500,
          'No se pudo obtener historial de notificaciones.',
          notificationsErr.message
        )
        return
      }

      if (!notifications?.length) {
        res.json({ notifications: [] })
        return
      }

      const notificationIds = notifications.map((item) => item.id)
      const userTargetIds = [
        ...new Set(notifications.map((item) => item.usuario_objetivo_id).filter(Boolean)),
      ]

      const [{ data: recipientsRows, error: recipientsErr }, { data: usersRows, error: usersErr }] =
        await Promise.all([
          adminSupabase
            .from('notificaciones_destinatarios')
            .select('notificacion_id, leida_at')
            .in('notificacion_id', notificationIds),
          userTargetIds.length
            ? adminSupabase
                .from('activadores')
                .select('usuario_id, nombre, email')
                .in('usuario_id', userTargetIds)
            : Promise.resolve({ data: [], error: null }),
        ])

      if (recipientsErr) {
        jsonError(
          res,
          500,
          'No se pudo obtener estado de destinatarios.',
          recipientsErr.message
        )
        return
      }

      if (usersErr) {
        jsonError(
          res,
          500,
          'No se pudo obtener detalle de usuarios objetivo.',
          usersErr.message
        )
        return
      }

      const statsMap = {}
      for (const row of recipientsRows ?? []) {
        if (!statsMap[row.notificacion_id]) {
          statsMap[row.notificacion_id] = { total: 0, read: 0 }
        }
        statsMap[row.notificacion_id].total += 1
        if (row.leida_at) {
          statsMap[row.notificacion_id].read += 1
        }
      }

      const usersMap = Object.fromEntries(
        (usersRows ?? []).map((item) => [
          item.usuario_id,
          {
            usuario_id: item.usuario_id,
            nombre: item.nombre ?? null,
            email: item.email ?? null,
          },
        ])
      )

      const payload = notifications.map((item) => {
        const stats = statsMap[item.id] ?? { total: 0, read: 0 }
        return {
          id: item.id,
          titulo: item.titulo,
          mensaje: item.mensaje,
          alcance: item.alcance,
          tipo_audiencia: item.tipo_audiencia ?? (item.alcance === 'user' ? 'users' : 'all'),
          rol_objetivo: item.rol_objetivo ?? null,
          usuarioObjetivo: item.usuario_objetivo_id
            ? usersMap[item.usuario_objetivo_id] ?? {
                usuario_id: item.usuario_objetivo_id,
                nombre: null,
                email: null,
              }
            : null,
          creado_por: item.creado_por,
          created_at: item.created_at,
          destinatarios_total: item.destinatarios_total ?? stats.total,
          destinatarios_leidos: stats.read,
          destinatarios_pendientes: Math.max(0, stats.total - stats.read),
        }
      })

      res.json({ notifications: payload })
    })
  )

  app.post(
    '/admin/notifications',
    asyncRoute(async (req, res) => {
      const rawTitle = req.body?.titulo
      const rawMessage = req.body?.mensaje
      const rawScope = req.body?.alcance
      const rawTargetUserId = req.body?.usuarioObjetivoId
      const rawAudience = req.body?.tipoAudiencia
      const targetRole = normalizeText(req.body?.rolObjetivo)
      const requestedUserIds = Array.isArray(req.body?.usuarioObjetivoIds)
        ? req.body.usuarioObjetivoIds.map(normalizeText).filter(Boolean)
        : []

      const title = normalizeText(rawTitle)
      const message = normalizeText(rawMessage)
      const audience = ['all', 'role', 'users'].includes(rawAudience)
        ? rawAudience
        : rawScope === 'user' ? 'users' : rawScope === 'all' ? 'all' : ''
      const scope = audience === 'users' ? 'user' : 'all'
      const targetUserId = normalizeText(rawTargetUserId)
      const specificUserIds = [...new Set([...requestedUserIds, ...(targetUserId ? [targetUserId] : [])])]
      const createdBy = normalizeText(req.portalUser?.email) || normalizeText(req.adminUser) || 'admin'

      if (title.length < 3 || title.length > 120) {
        jsonError(res, 400, 'El titulo debe tener entre 3 y 120 caracteres.')
        return
      }

      if (message.length < 3 || message.length > 2000) {
        jsonError(res, 400, 'El mensaje debe tener entre 3 y 2000 caracteres.')
        return
      }

      if (!audience) {
        jsonError(res, 400, 'Tipo de audiencia invalido.')
        return
      }
      if (audience === 'role' && !['activador', 'lider', 'facturador'].includes(targetRole)) {
        jsonError(res, 400, 'rolObjetivo invalido.')
        return
      }
      if (audience === 'users' && (!specificUserIds.length || specificUserIds.length > 500)) {
        jsonError(res, 400, 'Selecciona entre 1 y 500 usuarios especificos.')
        return
      }

      let recipients = []

      if (audience === 'all' || audience === 'role') {
        let recipientsQuery = adminSupabase.from('activadores')
          .select('usuario_id, nombre, email, rol').eq('estado', 'activo').not('usuario_id', 'is', null)
        if (audience === 'role') recipientsQuery = recipientsQuery.eq('rol', targetRole)
        const { data, error } = await recipientsQuery

        if (error) {
          jsonError(res, 500, 'No se pudo obtener lista de destinatarios.', error.message)
          return
        }

        const dedupedRecipients = new Map()
        for (const item of data ?? []) {
          if (item?.usuario_id && !dedupedRecipients.has(item.usuario_id)) {
            dedupedRecipients.set(item.usuario_id, item)
          }
        }

        recipients = [...dedupedRecipients.values()]
      } else {
        const { data, error } = await adminSupabase
          .from('activadores')
          .select('usuario_id, nombre, email, rol')
          .in('usuario_id', specificUserIds)
          .eq('estado', 'activo')

        if (error) {
          jsonError(res, 500, 'No se pudo validar el usuario objetivo.', error.message)
          return
        }

        recipients = [...new Map((data ?? []).filter((item) => item?.usuario_id).map((item) => [item.usuario_id, item])).values()]
      }

      if (!recipients.length) {
        jsonError(res, 400, 'No hay destinatarios disponibles para este envio.')
        return
      }

      const notificationPayload = {
        titulo: title,
        mensaje: message,
        alcance: scope,
        usuario_objetivo_id: audience === 'users' && specificUserIds.length === 1 ? specificUserIds[0] : null,
        tipo_audiencia: audience,
        rol_objetivo: audience === 'role' ? targetRole : null,
        destinatarios_total: recipients.length,
        creado_por: createdBy,
      }

      let { data: insertedNotification, error: insertNotificationErr } = await adminSupabase
        .from('notificaciones')
        .insert(notificationPayload)
        .select('id, titulo, mensaje, alcance, usuario_objetivo_id, tipo_audiencia, rol_objetivo, destinatarios_total, creado_por, created_at')
        .single()

      if (insertNotificationErr && isMissingOrganizationSchema(insertNotificationErr)) {
        const legacyPayload = {
          titulo: title, mensaje: message, alcance: scope,
          usuario_objetivo_id: audience === 'users' && specificUserIds.length === 1 ? specificUserIds[0] : null,
          creado_por: createdBy,
        }
        const legacyInsert = await adminSupabase.from('notificaciones').insert(legacyPayload)
          .select('id, titulo, mensaje, alcance, usuario_objetivo_id, creado_por, created_at').single()
        insertedNotification = legacyInsert.data
        insertNotificationErr = legacyInsert.error
      }

      if (insertNotificationErr || !insertedNotification?.id) {
        jsonError(
          res,
          500,
          'No se pudo registrar la notificacion.',
          insertNotificationErr?.message
        )
        return
      }

      const recipientsPayload = recipients.map((item) => ({
        notificacion_id: insertedNotification.id,
        usuario_id: item.usuario_id,
      }))

      const { error: insertRecipientsErr } = await adminSupabase
        .from('notificaciones_destinatarios')
        .insert(recipientsPayload)

      if (insertRecipientsErr) {
        await adminSupabase
          .from('notificaciones')
          .delete()
          .eq('id', insertedNotification.id)

        jsonError(
          res,
          500,
          'No se pudo registrar destinatarios de la notificacion.',
          insertRecipientsErr.message
        )
        return
      }

      res.status(201).json({
        notification: {
          id: insertedNotification.id,
          titulo: insertedNotification.titulo,
          mensaje: insertedNotification.mensaje,
          alcance: insertedNotification.alcance,
          tipo_audiencia: audience,
          rol_objetivo: audience === 'role' ? targetRole : null,
          usuarioObjetivo:
            audience === 'users' && specificUserIds.length === 1
              ? {
                  usuario_id: specificUserIds[0],
                  nombre: recipients[0]?.nombre ?? null,
                  email: recipients[0]?.email ?? null,
                }
              : null,
          creado_por: insertedNotification.creado_por,
          created_at: insertedNotification.created_at,
          destinatarios_total: recipientsPayload.length,
          destinatarios_leidos: 0,
          destinatarios_pendientes: recipientsPayload.length,
        },
      })
    })
  )

  app.use((error, _req, res, _next) => {
    console.error('[admin-api] Error no controlado:', sanitizeLogDetails(error))

    if (res.headersSent) {
      return
    }

    jsonError(res, 500, 'Error interno del servidor.')
  })

  return app
}
