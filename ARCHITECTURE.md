# Architecture

## Overview

Vue SPA → `/api` (Express, one Vercel function in `gru1`) → Supabase. The API uses the service-role key, so it scopes access by hand. Roles: `administrador`, `lider`, `banco`. The mobile app writes to the same database.

## Layout

- `src/pages`, `src/components`, `src/lib`: the SPA (views, components, shared logic).
- `server/app.js`: the API (`/portal/*` scoped reads, `/admin/*` writes, `/evidencia/*` photo links). Helpers in `server/*.js`.
- `api/index.js`: Vercel entry. `tests/`: `node:test`. `docs/`: diagnostics. `supabase/`: schema and migrations (with README).

## Practices

- Every `/portal` request resolves the user; activations endpoints scope leaders with `resolverAlcanceLider` + `aplicarAlcanceLider` and never filter by profile `estado`.
- Lists are paginated on the server with filters in SQL. Only the detail endpoint signs photos and looks up emails.
- Order is always `created_at desc, id asc`.
- Select lists are static; no schema discovery at runtime. The schema is `supabase/migrations/20261029000000_baseline.sql` plus later migrations.
- Photos are served through HMAC evidence links; the service-role key never reaches the client.
- Pure logic lives in `src/lib` and `server/*.js`; HTTP tests run the real app against `tests/helpers/fakeSupabase.mjs`.
- Database changes need approval and go through `supabase/migrations/` (workflow in `supabase/README.md`). Never edit the schema in the SQL Editor.
- Deploy is a push to `main` (Vercel): run test, lint and build first.

## Wishlist

- Split `server/app.js` into routers and services
- Fewer lookups per request in auth
- Métricas aggregated in a SQL view
- Normalize `ciudad_activacion` at write time
- Dashboard aggregation moved to `src/lib`
- Staging Supabase and RLS tests
- Expiring evidence links, real rate limiting, no Basic auth
- Format check clean and tests gating deploys
