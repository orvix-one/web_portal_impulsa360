// Mide la latencia del portal desde fuera (como la ve un navegador).
//
//   PORTAL_BASE_URL=https://tu-dominio.com/api PORTAL_TOKEN=<access_token> npm run performance
//
// PORTAL_TOKEN: access_token de una sesion iniciada (DevTools > Application >
// Local Storage > sb-...-auth-token > access_token). No lo guardes en el repo.
// Opciones: RUNS (default 5).
const base = (process.env.PORTAL_BASE_URL ?? '').replace(/\/$/, '')
const token = process.env.PORTAL_TOKEN ?? ''
const runs = Number(process.env.RUNS ?? 5)

if (!base || !token) {
  console.error('Faltan PORTAL_BASE_URL y/o PORTAL_TOKEN (ver cabecera del script).')
  process.exit(1)
}

const ms = (value) => Math.round(value)
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

async function request(path) {
  const inicio = performance.now()
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip, br' },
  })
  const body = await response.arrayBuffer()
  const elapsed = performance.now() - inicio
  if (!response.ok) {
    const detalle = new TextDecoder().decode(body).replace(/\s+/g, ' ').slice(0, 200)
    const pista = /<html|vercel authentication|sso/i.test(detalle)
      ? ' (parece la proteccion de despliegue de Vercel, no la API: usa el dominio de produccion o desactiva la proteccion del preview)'
      : ' (si dice "Sesion invalida": el access_token expiro (dura ~1 h) o no es de un admin/lider/banco activo)'
    throw new Error(`${path} -> HTTP ${response.status}: ${detalle}${pista}`)
  }
  let json = null
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    /* no es JSON */
  }
  return {
    elapsed,
    bytes: body.byteLength,
    encoding: response.headers.get('content-encoding') ?? 'ninguna',
    timing: response.headers.get('server-timing') ?? '',
    json,
  }
}

const fila = (nombre, muestras, extra) => {
  const t = muestras.map((m) => m.elapsed)
  console.log(
    `${nombre.padEnd(22)} p50 ${String(ms(percentile(t, 50))).padStart(6)}  p95 ${String(ms(percentile(t, 95))).padStart(6)} ms  ${extra}`,
  )
}

console.log(`${base}  (${runs} runs)`)

for (const path of ['/portal/me', '/portal/plazas', '/portal/users']) {
  const muestras = []
  for (let i = 0; i < runs; i += 1) muestras.push(await request(path))
  const ultima = muestras.at(-1)
  fila(path, muestras, `${(ultima.bytes / 1024).toFixed(0)} KB  encoding=${ultima.encoding}`)
  if (ultima.timing) console.log(`  Server-Timing: ${ultima.timing}`)
}

{
  const muestras = []
  for (let i = 0; i < runs; i += 1) muestras.push(await request('/portal/activations/page?page=1&pageSize=50'))
  const ultima = muestras.at(-1)
  fila(
    'activations /page (50)',
    muestras,
    `${(ultima.bytes / 1024).toFixed(0)} KB  encoding=${ultima.encoding}${ultima.json ? '' : '  (sin JSON: endpoint no desplegado?)'}`,
  )
  if (ultima.timing) console.log(`  Server-Timing: ${ultima.timing}`)
}

{
  const muestras = []
  for (let i = 0; i < runs; i += 1) muestras.push(await request('/portal/metrics/activations'))
  const ultima = muestras.at(-1)
  fila(
    'metricas (todas)',
    muestras,
    `${ultima.json?.activations?.length ?? 0} filas, ${(ultima.bytes / 1024 / 1024).toFixed(2)} MB  encoding=${ultima.encoding}${ultima.json ? '' : '  (sin JSON: endpoint no desplegado?)'}`,
  )
  if (ultima.timing) console.log(`  Server-Timing: ${ultima.timing}`)
}
