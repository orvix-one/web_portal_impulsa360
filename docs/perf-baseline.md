# Línea base de rendimiento del portal

Se actualiza en cada fase de `docs/` / plan de latencia. Objetivo: navegación fluida sin que el tiempo crezca con el total de activaciones.

## Cómo medir

Ver la cabecera de `scripts/performance.mjs` (`npm run performance`).

## Metas (a confirmar contra esta línea base)

| Vista | Meta |
|---|---|
| Activaciones, primer pintado | ≤ 1,5 s p50 |
| Métricas, en frío | ≤ 3 s p50 |
| Métricas, revisitada dentro del TTL de caché | ≤ 300 ms |
| Crecimiento con el total de filas | ninguna vista lineal, salvo la descarga delgada de Métricas |

## Mediciones

Completar al correr el script. Fecha / commit / región de la función de Vercel en cada columna.

| Medición | Antes (2026-10-27, prod) | Tras región (____) | Fase 1 | Fase 2 |
|---|---|---|---|---|
| `/portal/me` p50 / p95 | 1343 / 2175 ms | | | |
| `/portal/users` p50 / p95 | 3260 / 3519 ms (143 KB) | | | |
| Carga completa `/portal/activations` p50 / p95 | 27494 / 30947 ms (3475 filas, 4 págs, 11.7 MB) | | | |
| Página de activaciones: `auth` / `db` / `email` / `sign` (ms) | | | | |
| Activaciones, navegador, frío / tibio | | | | |
| Métricas, navegador, frío / tibio | | | | |

## Datos a registrar que condicionan fases siguientes

- [x] Compresión: `br` ya activo en respuestas grandes; la Fase 2 no la agrega.
- [ ] Tipo de `fecha_activacion` (`date` o `timestamp`), leído de una fila de muestra. Decide cómo se filtran las fechas en servidor (Fase 1).
- [ ] Región de Supabase: ____  ·  Región de la función de Vercel (antes): ____  ·  (después): ____
