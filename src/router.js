import { createRouter, createWebHistory } from 'vue-router'
import { initializeAuth, useAuth } from './lib/authStore'

const routes = [
  { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
  { path: '/', redirect: '/activaciones' },
  {
    path: '/activaciones',
    component: () => import('./pages/ActivacionesPage.vue'),
  },
  {
    path: '/impulsadores',
    component: () => import('./pages/ImpulsadoresPage.vue'),
  },
  {
    path: '/metricas',
    component: () => import('./components/MetricsDashboard.vue'),
  },
  {
    path: '/usuarios',
    component: () => import('./components/Usuarios.vue'),
  },
  {
    path: '/equipos',
    component: () => import('./components/Equipos.vue'),
  },
  {
    path: '/plazas',
    component: () => import('./pages/PlazasPage.vue'),
  },
  {
    path: '/notificaciones',
    component: () => import('./components/Notificaciones.vue'),
  },
  {
    path: '/capacidad',
    component: () => import('./components/Capacidad.vue'),
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach(async (to) => {
  await initializeAuth()
  const { session, profile } = useAuth()
  if (to.meta.public) return profile.value ? '/activaciones' : true
  if (!session.value || !profile.value) return { path: '/login', query: { redirect: to.fullPath } }
  if (profile.value.rol === 'lider' && ['/usuarios', '/equipos', '/notificaciones', '/capacidad', '/plazas'].includes(to.path)) return '/activaciones'
  if (profile.value.rol === 'banco' && ['/usuarios', '/equipos', '/notificaciones', '/capacidad', '/plazas'].includes(to.path)) return '/activaciones'
  return true
})
