// Expone la duracion de cada fase de la peticion en la cabecera Server-Timing.
const METRIC_NAME = /^[a-z0-9_-]+$/i

export function formatServerTiming(metrics) {
  return [...metrics]
    .filter(([name]) => METRIC_NAME.test(name))
    .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
    .join(', ')
}

export function serverTimingMiddleware(req, res, next) {
  const inicio = process.hrtime.bigint()
  const metrics = new Map()
  const sumar = (name, ms) => metrics.set(name, (metrics.get(name) ?? 0) + ms)

  req.timing = {
    async measure(name, fn) {
      const t0 = process.hrtime.bigint()
      try {
        return await fn()
      } finally {
        sumar(name, Number(process.hrtime.bigint() - t0) / 1e6)
      }
    },
  }

  const writeHead = res.writeHead
  res.writeHead = function writeHeadConTiming(...args) {
    if (!res.headersSent) {
      const total = new Map(metrics).set('total', Number(process.hrtime.bigint() - inicio) / 1e6)
      res.setHeader('Server-Timing', formatServerTiming(total))
    }
    return writeHead.apply(this, args)
  }
  next()
}
