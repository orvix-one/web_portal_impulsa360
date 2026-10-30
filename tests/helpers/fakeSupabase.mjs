// Cliente Supabase en memoria que soporta solo lo que usan los handlers del portal.
// Staging o Docker DB
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

function sinComillas(value) {
  return value.replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1')
}

function evaluarTermino(row, term) {
  const and = term.match(/^and\((.*)\)$/)
  if (and) return splitTopLevel(and[1]).every((part) => evaluarTermino(row, part))
  const [column, op, ...rest] = term.split('.')
  const value = rest.join('.')
  if (op === 'eq') return String(row[column]) === value
  if (op === 'is') return value === 'null' ? row[column] == null : false
  if (op === 'in') {
    const valores = splitTopLevel(value.slice(1, -1)).map(sinComillas)
    return row[column] != null && valores.includes(String(row[column]))
  }
  throw new Error(`fakeSupabase: operador no soportado en or(): ${term}`)
}

// LIKE de Postgres: % = cualquier cadena, _ = un caracter, \ escapa.
function patronLike(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '\\' && i + 1 < pattern.length) {
      i += 1
      source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (char === '%') source += '.*'
    else if (char === '_') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'is')
}

function comparar(a, b) {
  if (a === b) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a < b ? -1 : 1
}

class Query {
  constructor(db, table) {
    this.db = db
    this.table = table
    this.predicates = []
    this.orders = []
    this.columns = '*'
    this.countMode = null
    this.headOnly = false
    this.window = null
  }

  select(columns = '*', options = {}) {
    this.columns = columns
    this.countMode = options.count ?? null
    this.headOnly = Boolean(options.head)
    return this
  }

  eq(column, value) {
    this.predicates.push((row) => row[column] === value)
    return this
  }
  in(column, values) {
    this.predicates.push((row) => values.includes(row[column]))
    return this
  }
  gte(column, value) {
    this.predicates.push((row) => row[column] != null && row[column] >= value)
    return this
  }
  lte(column, value) {
    this.predicates.push((row) => row[column] != null && row[column] <= value)
    return this
  }
  ilike(column, pattern) {
    const regex = patronLike(pattern)
    this.predicates.push((row) => row[column] != null && regex.test(String(row[column])))
    return this
  }
  or(expression) {
    this.db.calls.or.push(expression)
    this.predicates.push((row) => splitTopLevel(expression).some((term) => evaluarTermino(row, term)))
    return this
  }
  order(column, { ascending = true } = {}) {
    this.orders.push({ column, ascending })
    return this
  }
  range(from, to) {
    this.window = [from, to]
    return this
  }
  maybeSingle() {
    this.wantsSingle = true
    return this
  }
  single() {
    return this.maybeSingle()
  }
  insert(row) {
    this.inserted = row
    return this
  }

  run() {
    this.db.calls.from.push(this.table)
    if (this.inserted) {
      const created = { id: `${this.table}-${(this.db.tables[this.table]?.length ?? 0) + 1}`, ...this.inserted }
      this.db.tables[this.table] = [...(this.db.tables[this.table] ?? []), created]
      return { data: created, error: null }
    }
    let rows = (this.db.tables[this.table] ?? []).filter((row) => this.predicates.every((predicate) => predicate(row)))
    const count = rows.length
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => comparar(a[column], b[column]) * (ascending ? 1 : -1))
    }
    if (this.window) {
      this.db.calls.range.push([this.table, ...this.window])
      rows = rows.slice(this.window[0], this.window[1] + 1)
    }
    if (this.columns !== '*') {
      const keys = this.columns.split(',').map((key) => key.trim())
      rows = rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))
    }
    if (this.wantsSingle) return { data: rows[0] ?? null, error: null }
    return { data: this.headOnly ? null : rows, error: null, count: this.countMode ? count : null }
  }

  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject)
  }
}

export function createFakeSupabase({ tables = {}, tokens = {} } = {}) {
  const db = { tables, calls: { from: [], or: [], sign: [], range: [] } }
  return {
    calls: db.calls,
    tables,
    from: (table) => new Query(db, table),
    auth: {
      async getUser(token) {
        const user = tokens[token]
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error('invalid token') }
      },
    },
    storage: {
      from: (bucket) => ({
        async createSignedUrls(paths, ttl) {
          db.calls.sign.push({ bucket, paths, ttl })
          return { data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${bucket}/${path}?ttl=${ttl}` })), error: null }
        },
      }),
    },
  }
}
