import { createAdminApiApp } from '../../server/app.js'
import { createFakeSupabase } from './fakeSupabase.mjs'

export const IDS = {
  admin: '00000000-0000-0000-0000-00000000000a',
  lider: '10000000-0000-0000-0000-000000000001',
  liderAjeno: '10000000-0000-0000-0000-000000000009',
  banco: '00000000-0000-0000-0000-00000000000b',
  activador: '20000000-0000-0000-0000-000000000001',
  ajeno: '20000000-0000-0000-0000-000000000002',
  inactivo: '30000000-0000-0000-0000-000000000001',
}

const perfil = (usuario_id, rol, extra = {}) => ({
  usuario_id,
  auth_user_id: `auth-${usuario_id}`,
  nombre: rol,
  email: `${rol}@test.bo`,
  rol,
  estado: 'activo',
  lider_id: null,
  puede_activar: false,
  ...extra,
})

// ids de activacion con formato uuid (el detalle los valida)
export const ACT = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`f${n}`, `a0000000-0000-4000-8000-00000000000${n}`]))
const fila = (n, extra) => ({ id: ACT[`f${n}`], nombre_comercio: null, foto_url: null, foto_cash_in: null, ...extra })

export const TOKENS = {
  admin: 'tok-admin',
  lider: 'tok-lider',
  banco: 'tok-banco',
  activador: 'tok-activador',
  inactivo: 'tok-inactivo',
}

export function seedTables() {
  const activadores = [
    perfil(IDS.admin, 'administrador'),
    perfil(IDS.lider, 'lider'),
    perfil(IDS.liderAjeno, 'lider'),
    perfil(IDS.banco, 'banco'),
    perfil(IDS.activador, 'activador', { lider_id: IDS.lider, email: 'activador@test.bo' }),
    perfil(IDS.ajeno, 'activador', { lider_id: IDS.liderAjeno, email: 'ajeno@test.bo' }),
    perfil(IDS.inactivo, 'lider', { estado: 'inactivo' }),
  ]
  const activador_roles = activadores.map((p) => ({ usuario_id: p.usuario_id, rol: p.rol }))
  const activaciones = [
    // f3 y f4 empatan en created_at para probar el desempate por id
    fila(1, {
      usuario_id: IDS.activador,
      lider_id_registro: IDS.lider,
      created_at: '2026-10-05T10:00:00Z',
      fecha_activacion: '2026-10-05',
      ciudad_activacion: 'la_paz',
      impulsador: 'Ana Pérez',
      zona_activacion: 'Centro',
      nombre_comercio: 'Tienda Uno',
      foto_url: 'u1/a.jpg',
      foto_cash_in: 'u1/b.jpg',
    }),
    fila(2, {
      usuario_id: IDS.ajeno,
      lider_id_registro: IDS.lider,
      created_at: '2026-10-04T10:00:00Z',
      fecha_activacion: '2026-10-04',
      ciudad_activacion: 'el_alto',
      impulsador: 'Beto Rojas',
      zona_activacion: 'Zona Sur',
      foto_url: 'u2/a.jpg',
    }),
    fila(3, {
      usuario_id: IDS.activador,
      lider_id_registro: IDS.liderAjeno,
      created_at: '2026-10-03T10:00:00Z',
      fecha_activacion: '2026-10-03',
      ciudad_activacion: 'la_paz',
      impulsador: 'Ana Pérez',
      zona_activacion: 'Sopocachi',
    }),
    fila(4, {
      usuario_id: IDS.ajeno,
      lider_id_registro: IDS.liderAjeno,
      created_at: '2026-10-03T10:00:00Z',
      fecha_activacion: '2026-10-03',
      ciudad_activacion: 'oruro',
      impulsador: 'Beto Rojas',
      zona_activacion: 'Centro',
    }),
    fila(5, {
      usuario_id: IDS.activador,
      lider_id_registro: null,
      created_at: '2026-10-02T10:00:00Z',
      fecha_activacion: '2026-10-02',
      ciudad_activacion: 'la_paz',
      impulsador: 'Ana Pérez',
      zona_activacion: 'Centro',
      foto_url: 'u1/c.jpg',
    }),
    fila(6, {
      usuario_id: IDS.ajeno,
      lider_id_registro: null,
      created_at: '2026-10-01T10:00:00Z',
      fecha_activacion: '2026-10-01',
      ciudad_activacion: null,
      impulsador: 'Beto Rojas',
      zona_activacion: 'Zona Sur',
    }),
  ]
  return { activadores, activador_roles, activaciones, plazas: [{ id: 'p1', nombre: 'La Paz', activa: true }] }
}

export function tokensFor() {
  const user = (usuarioId) => ({ id: `auth-${usuarioId}` })
  return {
    [TOKENS.admin]: user(IDS.admin),
    [TOKENS.lider]: user(IDS.lider),
    [TOKENS.banco]: user(IDS.banco),
    [TOKENS.activador]: user(IDS.activador),
    [TOKENS.inactivo]: user(IDS.inactivo),
  }
}

export const TEST_ENV = {
  SUPABASE_URL: 'http://supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
  ADMIN_BASIC_USER: 'admin',
  ADMIN_BASIC_PASS: 'pass',
  EVIDENCE_LINK_SECRET: 'secreto-de-prueba',
  EVIDENCE_PUBLIC_BASE_URL: 'https://portal.test/api',
}

// Levanta la app real en un puerto efimero con un Supabase en memoria.
export async function startPortal(tables = seedTables()) {
  const supabase = createFakeSupabase({ tables, tokens: tokensFor() })
  const app = createAdminApiApp({ env: TEST_ENV, adminSupabase: supabase })
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const get = (path, token) => fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { supabase, get, close: () => new Promise((resolve) => server.close(resolve)) }
}
