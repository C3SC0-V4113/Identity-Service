# Deployment Guide

How to deploy `identity-service` (Fastify + Prisma + PostgreSQL) to production.
**Railway** is the primary target; alternatives and database options follow, plus
the production checklist and known cross-site caveats.

## What you are deploying

- A Node ESM server: `npm run build` (tsc → `dist/`), `npm start`
  (`node dist/server.js`). Binds `HOST` / `PORT`.
- A PostgreSQL database reached via `DATABASE_URL`, with schema applied by Prisma
  **migrations** (`prisma migrate deploy`).
- A liveness route: `GET /health` → `200 { "status": "ok", "service": "identity-service" }`.

### Environment variables

Validated by [`src/config/env.ts`](../src/config/env.ts) (the app fails fast if
they are wrong):

| Variable              | Required    | Default                    | Notes                                                                        |
| --------------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`        | **yes**     | —                          | Postgres connection string (must be a valid URL).                            |
| `NODE_ENV`            | recommended | `development`              | Set to `production`. Also flips the session cookie to `secure` (HTTPS-only). |
| `PORT`                | platform    | `3000`                     | Most PaaS inject this; bind to it.                                           |
| `HOST`                | recommended | `0.0.0.0`                  | Keep `0.0.0.0` so the platform can reach the container.                      |
| `SESSION_COOKIE_NAME` | no          | `identity_service_session` | Override only if you need a specific cookie name.                            |
| `LOG_LEVEL`           | no          | `info`                     | `fatal`…`trace`/`silent`.                                                    |

> The app reads a local `.env` if present, but on a PaaS set these in the
> platform's variable store, **not** in a committed file. Never commit real
> secrets or service-principal tokens.

---

## Railway (primary)

Railway runs the Node service and a managed Postgres plugin side by side.

### 1. Provision

1. Create a Railway project from your GitHub repo (or `railway init` with the CLI).
2. Add a **PostgreSQL** database to the project (New → Database → PostgreSQL).
   Railway exposes a `DATABASE_URL` reference variable for it.

### 2. Configure the service

- **Variables:** set `NODE_ENV=production`, `HOST=0.0.0.0`,
  `DATABASE_URL=${{Postgres.DATABASE_URL}}` (reference the DB plugin), and
  optionally `SESSION_COOKIE_NAME` / `LOG_LEVEL`. Railway injects `PORT`
  automatically — do not hard-code it.
- **Build command:** `npm ci && npm run build` (Railway runs `prisma generate`
  automatically through the `@prisma/client` postinstall; if not, add
  `npm run db:generate` to the build).
- **Start command:** `npm start`.
- **Healthcheck path:** `/health` (Settings → Healthcheck).

### 3. Apply migrations on release

Run migrations as a **release/pre-deploy step**, separate from `start`, so a
fresh container never serves traffic against an un-migrated schema. Use the
production-safe command (never `migrate dev`):

```bash
npx prisma migrate deploy
```

On Railway set this as the service's **pre-deploy command** (Settings → Deploy →
Pre-deploy Command), or run it once via `railway run npx prisma migrate deploy`.

### 4. First-run bootstrap (one-time)

These are local maintenance scripts; run them against production with
`railway run` (or any shell with the production `DATABASE_URL`):

```bash
railway run npm run db:seed                                   # projects + roles
railway run npm run db:bootstrap-admin -- --email you@example.com --all-projects
railway run npm run db:bootstrap-service-principal -- --slug openclaw-ops --name "OpenClaw Ops" --all-projects
```

The service-principal bootstrap prints the bearer token **once** — store it in the
consumer's secret store (e.g. `mcp-server`), never in this repo.

---

## Alternatives (aligned with platform ADR 0006)

All run the same `build` → `migrate deploy` → `start` shape; only the wiring
differs.

- **Render.** Web Service from the repo: build `npm ci && npm run build`, start
  `npm start`, health check path `/health`. Add a **Render PostgreSQL** instance
  and set `DATABASE_URL` from it. Run `prisma migrate deploy` as a
  [pre-deploy command](https://render.com/docs/deploys#pre-deploy-command).
- **Fly.io.** `fly launch` generates a `Dockerfile` + `fly.toml`; deploy with
  `fly deploy`. Use **Fly Postgres** (or an external DB). Run migrations in a
  release command (`[deploy] release_command = "npx prisma migrate deploy"` in
  `fly.toml`). Expose the internal port via `[http_service]` and set a `/health`
  check.
- **Koyeb.** Git-driven build (Buildpack or Dockerfile), start `npm start`,
  health check `/health`. Attach a managed Postgres (Koyeb or external) and set
  `DATABASE_URL`. Run `prisma migrate deploy` as a one-off / pre-deploy job.

A container image works everywhere: build with Node 20+, run
`npx prisma migrate deploy && node dist/server.js` (or split migrate into a
release job). Pin Node to match local (`@types/node` targets Node 24; Node ≥ 20 is
required for global `fetch`).

## Database options

- **Railway PostgreSQL (primary).** Co-located with the service, zero extra setup,
  one `DATABASE_URL` reference. Good default.
- **Neon.** Serverless Postgres with branching; use the **pooled** connection
  string for the app. Prisma works over the standard `DATABASE_URL`; for
  migrations against a pooler, use the direct (non-pooled) URL.
- **Supabase.** Managed Postgres; use the connection string from Project Settings →
  Database. Use the session/direct connection for `prisma migrate deploy` and the
  pooler for the running app if you hit connection limits.

Whatever you pick, `prisma migrate deploy` applies the committed migrations in
`prisma/migrations`; the app does not auto-migrate at boot.

---

## Production checklist & cross-site caveats

The current defaults assume the front-end and the API are served on the **same
site** (e.g. behind one domain via the BFF pattern in the integration guides). For
that topology nothing extra is needed. For a genuinely cross-origin browser
deployment, mind these — two of them require a small **code change**, not just
config:

- **CORS is disabled.** [`src/app.ts`](../src/app.ts) registers CORS with
  `origin: false`. Cross-origin browser calls need CORS enabled for the specific
  front-end origin **with `credentials: true`**. (Server-to-server callers such as
  `mcp-server` and a same-origin BFF are unaffected.)
- **Cookie `sameSite` is `lax`.** [`src/modules/auth/auth.cookies.ts`](../src/modules/auth/auth.cookies.ts)
  sets `sameSite: 'lax'`. True cross-site requests need `sameSite=none; secure`,
  which is a code change. `lax` covers same-site usage.
- **`secure` requires HTTPS.** In production the cookie is `secure`
  (`NODE_ENV === 'production'`), so the API **must** be served over HTTPS. Railway,
  Render, Fly, and Koyeb all provide TLS on their default domains.
- **Rate limiting.** 100 req/min per client is registered in-process; if you run
  multiple instances behind a load balancer, the limit is per-instance.
- **Trust proxy / client IP.** Behind a platform proxy, the audited IP comes from
  the proxy unless you configure Fastify `trustProxy`. Consider this if accurate
  client IPs matter for the admin audit trail.

> **Optional code follow-up.** Making `CORS_ORIGIN` and the cookie `sameSite`
> configurable via environment variables would let a single build serve both
> same-site and cross-site deployments. It is intentionally **not** part of this
> guide — flagged here so the cross-site path is a conscious decision, not a
> surprise.

## Smoke test after deploy

```bash
curl -i https://<your-api>/health
# HTTP/1.1 200 OK
# {"status":"ok","service":"identity-service"}
```

Then exercise a project endpoint (replace the slug) to confirm the DB is wired:

```bash
curl -i -X POST https://<your-api>/projects/other-gpt/auth/register/email-check \
  -H "Content-Type: application/json" -d '{"email":"smoke@example.com"}'
# 200 with { "email", "exists", "nextStep" }
```
