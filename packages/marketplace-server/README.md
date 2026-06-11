# @synapse/marketplace-server

The Synapse marketplace backend — a **Fastify + Drizzle (Postgres)** API and the
authoritative source for users, plugins, publishing, downloads, and ratings.
Request/response bodies validate against `@synapse/marketplace-types`, the
contract shared with the CLI, desktop app, and web portal.

> Status: **M1** — server skeleton, schema, and authentication (GitHub OAuth via
> the CLI device flow + opaque sessions). Publishing, browse/search, downloads,
> and ratings land in later milestones.

## Stack

- **Fastify** — long-running Node HTTP server.
- **Drizzle ORM** + **node-postgres** (`pg`) — talks to **Neon** (or any Postgres)
  in production; **pglite** (in-process WASM Postgres) in tests.
- **zod** — request/response validation via the shared contract package.

## Layout

```
src/
├─ index.ts              # entrypoint (loads config, connects, listens)
├─ app.ts                # buildApp(deps) → wired Fastify instance (DI seam)
├─ config.ts            # env config (zod)
├─ auth/github.ts        # IdentityProvider port + GitHub OAuth implementation
├─ db/
│  ├─ schema.ts          # Drizzle schema (mirrors marketplace-types)
│  ├─ client.ts          # MarketplaceDb type + node-postgres factory
│  └─ migrate.ts         # apply migrations (prod/CI)
├─ services/             # user / session / device-code services
├─ routes/               # health, auth (device flow), session (whoami)
└─ test/harness.ts       # pglite-backed app for integration tests
drizzle/                 # generated SQL migrations (committed)
```

## Authentication (M1)

- **CLI device flow** (RFC 8628-style): `POST /auth/device/start` →
  `POST /auth/device/poll` (the CLI polls); the browser leg resolves the GitHub
  identity and calls `POST /auth/device/approve`.
- **Sessions** are opaque bearer tokens; only their SHA-256 is stored, so a DB
  leak exposes no usable credential. `GET /session` is `whoami`.
- **Identity is provider-agnostic** (`users` ⇄ `auth_identities`), so email /
  Google can be added later without migrating the user table.

## Commands

```bash
pnpm -F @synapse/marketplace-server dev          # tsx watch (needs .env)
pnpm -F @synapse/marketplace-server typecheck
pnpm -F @synapse/marketplace-server db:generate  # regenerate SQL after schema edits
pnpm -F @synapse/marketplace-server db:migrate    # apply migrations (needs DATABASE_URL)
pnpm -F @synapse/marketplace-server build
```

Tests run from the repo root (`pnpm test`) against pglite — **no database or
network required**.
