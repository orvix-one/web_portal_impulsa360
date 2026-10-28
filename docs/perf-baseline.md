# Línea base de rendimiento del portal

Se actualiza al cierre de cada fase del plan de latencia. Objetivo: navegación fluida sin que el tiempo crezca con el total de activaciones.

## Cómo medir

Ver la cabecera de `scripts/performance.mjs` (`npm run performance`).

## Metas (a confirmar contra esta línea base)

| Vista | Meta |
|---|---|
| Activaciones, primer pintado | ≤ 1,5 s p50 |
| Métricas, en frío | ≤ 3 s p50 |
| Crecimiento con el total de filas | ninguna vista lineal, salvo la descarga delgada de Métricas |

## Mediciones

Fuente: `npm run performance` contra producción (5 corridas). Tiempos en ms, formato p50 / p95. "Cliente" es lo que ve quien llama; "servidor" viene de `Server-Timing`. Las columnas son hitos: antes de cambiar nada, tras mover Vercel a gru1, y tras cada fase.

### 1. Endpoints pequeños (tiempo de cliente)

| Endpoint | Antes | Tras gru1 | Fase 1 | Fase 2 |
|---|---|---|---|---|
| `/portal/me` | 1343 / 2175 | 405 / 665 | 711 / 924 (servidor 178) | |
| `/portal/plazas` | 1326 / 1620 | 239 / 321 | 236 / 311 (servidor 108) | |
| `/portal/users` (143 KB) | 3260 / 3519 | 534 / 597 | 557 / 1348 (servidor 365) | |

Estos endpoints no se tocaron en la Fase 1: las diferencias entre corridas son ruido de red. Los reduce la Fase 3 (costo de auth por petición).

### 2. Activaciones (lo que carga la pantalla)

| Medición | Antes | Tras gru1 | Fase 1 | Fase 2 |
|---|---|---|---|---|
| Primera pantalla: cliente | 8026 (1.ª página legada, 1000 filas, 3.4 MB) | ~1900 (ídem) | **205 / 346** (50 filas, 20 KB) | |
| Primera pantalla: servidor | n/d | 1042 | **109** | |
| Carga completa del endpoint legado (3486 filas, 11.8 MB, 4 págs) | 27494 / 30947 | 5845 / 7897 | 7386 / 8699 | |

El endpoint legado sigue en uso solo por Métricas; no cambió en la Fase 1 y su tiempo varía entre corridas (el firmado de fotos va de 0,7 a 1,1 s por página).

### 3. Desglose del servidor (`Server-Timing`, una página)

| Fase | Legado: tras gru1 | Legado: Fase 1 | `/page`: Fase 1 |
|---|---|---|---|
| auth | 70 | 117 | 67 |
| db | 162 | 138 | 42 |
| email | 36 | 65 | no aplica |
| sign (firmado de fotos) | 732 | 810 | no aplica |
| **total** | **1042** | **1163** | **109** |

### 4. Navegador (por completar)

Medir con DevTools → Network, desde la navegación hasta ver la tabla o los KPIs.

| Vista | Antes | Fase 1 | Fase 2 |
|---|---|---|---|
| Activaciones, frío / tibio | | | |
| Métricas, frío / tibio | | | |

## Datos que condicionan fases siguientes

- [x] **Compresión:** `br` ya activo en respuestas grandes. La Fase 2 no la agrega.
- [x] **Tipo de `fecha_activacion`:** `date`, verificado en producción (ver `docs/esquema-remoto.md`). Los filtros `gte`/`lte` con `YYYY-MM-DD` son correctos.
- [ ] **Región de Supabase:** ____ (completar desde Settings → General). El salto de 1343 ms a 405 ms en `/portal/me` al mover Vercel a gru1 sugiere sa-east-1, pero no es una confirmación.
- [x] **Región de la función de Vercel:** ahora `gru1`. La anterior no se verificó (se asume el valor por defecto `iad1`).

## Resultado Fase 1 (2026-10-27, producción)

- Primera pantalla de Activaciones (`/page`, 50 filas): **205 ms p50 / 346 ms p95**, 20 KB. Antes: 8026 ms por página de 1000 filas (3.4 MB), y ~1900 ms tras mover la región.
- Tiempo de servidor por página: 1163 ms → 109 ms (auth 67, db 42). Ya no hay firmado de fotos ni búsqueda de correos.
- El costo ya no crece con el total de activaciones.
- Piso de red observado: ~200 ms (`/portal/plazas`: 236 ms de cliente con 108 ms de servidor). Lo que queda es auth (~65–125 ms por petición) y la red hasta Brasil.

## Fase 2: Métricas (cambios, pendiente de medir en producción)

Qué cambió:

- **Endpoint nuevo `GET /portal/metrics/activations`** (reemplaza al `GET /portal/activations?from&to`, eliminado). Devuelve solo las ~22 columnas que lee el tablero, sin correos ni fotos firmadas. La primera página trae el total (`count`) y las demás se piden en paralelo, máximo 4 a la vez para no saturar el pool de PostgREST.
- **Leaflet** se descarga solo al montar el mapa (chunk aparte de ~150 KB).
- `npm run performance` ahora mide `/portal/metrics/activations` en lugar de la carga paginada legada.

Qué medir (mismo procedimiento que arriba) y anotar en las columnas "Fase 2" de las tablas 1 a 3:

| Medición | Antes (legado, Fase 1) | Fase 2 |
|---|---|---|
| `metricas (todas)`: cliente p50 / p95 | 7386 / 8699 (3486 filas, 11.8 MB, 4 págs) | |
| Tamaño de la respuesta | 11.8 MB | |
| Desglose servidor (`auth` / `team` / `db` / `total`) | auth 117, sign 810 por página | |
| Navegador, Métricas en frío | | |
