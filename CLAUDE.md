# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-only Kaggle account manager (per-user accounts, no shared workspaces yet): the first module of a planned "AI Research OS". The UI copy, error messages and docs are in Vietnamese. Keep new user-facing strings in Vietnamese.

## Commands

The only supported run setup is Docker Compose from the repo root. The database is a hosted **Supabase** Postgres; there is no local db container. It needs a root `.env` with `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64url) and `DATABASE_URL`, which is the Supabase **Session pooler** URL (IPv4, port 5432) ending in `?sslmode=require&uselibpqcompat=true`. The README has a key generator, and `.env.example` shows the URL format.

```powershell
docker compose up --build -d   # build and start web on http://127.0.0.1:3000
docker compose down            # stop
```

Inside `apps/web` (npm, lockfile committed): `npm run dev`, `npm run build`, `npm run start`. Running outside Docker requires `DATABASE_URL` and `CREDENTIAL_ENCRYPTION_KEY` in the environment.

If host port 3000 is taken, set `WEB_PORT` and a matching `BETTER_AUTH_URL` (e.g. `http://localhost:3001`) in `.env`. The API's CSRF check compares `Origin` against `BETTER_AUTH_URL`, so a mismatch makes every write fail with "Nguồn yêu cầu không hợp lệ".

There is no linter or CI. `npm run build` (Next.js type-checks with strict TS) is the main check. `tests/auth-isolation.mjs` is an end-to-end auth/ownership/CSRF script. It needs a disposable database and a server on port 3002 (`AUTH_TEST_BASE=http://localhost:3002 node tests/auth-isolation.mjs`). Never point it at the real Supabase database: it creates users and claims ownerless connections.

## Architecture

Everything lives in `apps/web`, a Next.js 16 / React 19 app. There is no Python backend and no separate API service.

- **API: one catch-all route handler.** `app/api/[...path]/route.ts` handles every endpoint. It routes by hand on `path` segments and HTTP method (`/api/health`, `/api/accounts`, `/api/accounts/:id`, and `/credential`, `/verify`, `/sync`, `/notebook-logs`, `/notebook-logs-stream` under it). It rejects cross-origin non-GET requests. Errors are thrown as `AppError(status, message)` and returned as `{ detail }` JSON; unknown errors become a generic 500. Add new endpoints as branches in `handler`.
- **Server lib: `lib/server.ts`** (`server-only`):
  - A global `pg` Pool.
  - `initialize()` lazily runs `CREATE TABLE IF NOT EXISTS compute_accounts` and enables RLS. There are no migrations; schema changes go here. Any new table must also `ENABLE ROW LEVEL SECURITY`, or Supabase's public Data API can read it.
  - Token encryption is hand-written **Fernet-compatible** AES-128-CBC + HMAC. It must stay compatible with tokens written by the former Python backend.
  - `kaggleCall(token, method, body)` POSTs to `https://api.kaggle.com/v1/kernels.KernelsApiService/<method>` with a Bearer token, mirroring the official Kaggle SDK's wire protocol. There is no Kaggle CLI or SDK dependency.
- **Auth.** Better Auth (email + password) is configured in `lib/auth.ts`, mounted at `app/api/auth/[...all]`, and stores data in the same Postgres. Its secret is derived from `CREDENTIAL_ENCRYPTION_KEY` unless `BETTER_AUTH_SECRET` is set. The accounts API requires a session and scopes every query by `owner_id`. The first registered user claims connections that have no owner. The container's start command runs `scripts/migrate-auth.mjs` first: it holds an advisory lock while it migrates the Better Auth tables and `compute_accounts`, and enables RLS on all of them.
- **Live logs.** `notebook-logs-stream` proxies Kaggle's `/v1/kernels/logs/stream/...` and re-emits it as SSE (`status` / `log` / `done` / `error` events), with a 30-minute cap and 1 MB buffer limits. `logs-screen.tsx` consumes it.
- **Persistence.** Only accounts (label, username, encrypted credential, verified flag) are stored in Postgres. Sync results (GPU/TPU quota, first 100 notebooks) and logs are returned to the browser and held in React state only. They are lost on reload by design. Credentials are never returned to the client.
- **Frontend.** `app/page.tsx` is a single client component that owns all state (accounts, sync data, modals) and renders the Accounts screen inline. `connector-screens.tsx` renders the other screens (overview, quota, notebooks, logs) and exports the shared `Screen` / `Account` / `SyncData` types. Styling is plain CSS (`style.css`, `screens.css`) with `lucide-react` icons; there is no Tailwind or component library.
- **Code style.** The existing code is dense, with many statements per line. Match it when editing these files.

## Docs vs. reality

- `docs/KAGGLE_CONNECTOR_ROADMAP.md` is the current task checklist for this module.
- `docs/AI_Research_OS_Architecture_Roadmap.md` is the long-term target design: FastAPI, Celery, pgvector, LangGraph, and a `apps/api` + `workers/` layout. **None of that exists yet.** The project deliberately moved to a Next.js-only backend. Do not scaffold Python services or the target layout unless asked.
- The Kaggle username is an unverified label. Sign-up is open, with no email verification or password reset, so the app binds to `127.0.0.1` only and must not be exposed publicly.
