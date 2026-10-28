# AGENTS.md

## Project shape

- Vue 3.5 + Vite 6 SPA in JS (no TS) with vue-router. UI and copy in Spanish (Bolivia, `America/La_Paz`). Views in `src/pages` and `src/components`, shared logic in `src/lib`.
- API: Express 5 in `server/app.js`, deployed as one Vercel function (`api/index.js`, `/api/*` rewrite, region `gru1`, next to Supabase). Locally: `npm run dev:api` + `npm run dev`.
- Supabase backend. The API uses the service-role key, so RLS does not apply: scope access by hand. Portal roles: `administrador`, `lider`, `banco`.
- The mobile app (`../impulsa360`) writes to the same database.

## Commands

- `npm test` (`node:test`, `tests/*.test.mjs`; one file: `node --test tests/<file>`), `npm run lint`, `npm run build`.
- `npm run format:check` and lint are a baseline, not gates. Do not reformat files you are not changing.
- `npm run performance` [temporary, needs removal] needs `PORTAL_BASE_URL` and `PORTAL_TOKEN` (see the script header).
- CI is Vercel auto-deploying on push to `main`: run test, lint and build before pushing.

## Docs to trust

- `docs/esquema-remoto.md` (real remote schemas; read one table with `(set -a; . ./.env; set +a; curl -s "$SUPABASE_URL/rest/v1/" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" | jq '.definitions.<table>')`) and `docs/perf-baseline.md` (temporary measurements and targets).
- `docs/bitacora_sesion.md` is stale (2026-03).

## Conventions

- Comments:
  - Default to zero.
  - Write one only to explain a non-obvious constraint, decision, invariant or workaround, in one concise sentence.
  - Never narrate what the code does, restate identifiers or summarize changes.
  - Prefer clear names and small functions.
  - Non-obvious files may start with a short, stable abstract.
- Flag every workaround you add or find, especially fundamental or high-debt ones: what it is, why it exists and the proper fix.
- Be concise in replies, docs, commit messages and PR text: lead with the result, skip narration.

## Maintaining this file

- Suggest updating `AGENTS.md` whenever commands, structure, endpoints, invariants or conventions change. Keep it short and remove stale entries.
