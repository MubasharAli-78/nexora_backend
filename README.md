# Nexora Backend

Production-grade multi-tenant SaaS backend for Nexora — NestJS + Prisma + Supabase PostgreSQL, custom JWT auth, RBAC, and native PostgreSQL RLS. Built from the architecture pack in `../nexora_backend_database_architecture_docs`.

## Stack

- **NestJS 11** (Express) — modular API
- **Prisma 6** — `app` schema models + migrations
- **Supabase PostgreSQL** — managed Postgres (transaction pooler for the app, session pooler for migrations)
- **Supabase Storage** (S3-compatible) — file bytes; metadata in `app.files`
- **Custom auth** — argon2id passwords, short-lived JWT access tokens, rotating opaque refresh tokens
- **RBAC** — roles/permissions in JWT, re-verified on every request, atomic permission toggles
- **RLS** — `tenant_id` isolation enforced in `withTenantContext()` + DB policies as a safety net
- **Zod** validation, **Helmet**, rate limiting, AES-256-GCM field encryption for PII/secrets

## Prerequisites

- Node 20+ and `pnpm`
- A Supabase project. Fill `.env` (already pre-filled): `DATABASE_URL`, `DIRECT_URL` (DB password **URL-encoded**), SMTP, and optionally the Supabase S3 storage keys.

> ⚠️ The DB password in `.env` is URL-encoded because it contains `#`, `%`, `+`, `,`. If you rotate it, encode reserved characters (`#`→`%23`, `%`→`%25`, `+`→`%2B`, `,`→`%2C`).

## First-time setup

```bash
pnpm install
pnpm prisma:generate

# 1) Create the app schema + all tables (uses DIRECT_URL / session pooler)
pnpm prisma db push --schema prisma/schema

# 2) Apply RLS policies, helper functions, triggers, and the permission-toggle stored procedure
pnpm prisma db execute --file prisma/sql/setup.sql --schema prisma/schema

# 3) Seed permissions, global role templates, providers, and a demo tenant
pnpm db:seed
```

Demo login created by the seed:

```
email:    owner@fashionco.test
password: Owner123!
tenant:   fashionco
```

## Run

```bash
pnpm start:dev          # http://localhost:4000/api/v1
# Swagger docs (non-prod):  http://localhost:4000/docs
# Health:                   GET /api/v1/health  and  /api/v1/health/db
```

## Auth quickstart

```bash
# Login (sets httpOnly cookies + returns accessToken)
curl -i -c cookies.txt -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@fashionco.test","password":"Owner123!"}'

# Bootstrap (drives the frontend: user, tenant, roles, permissions, navigation)
curl -b cookies.txt http://localhost:4000/api/v1/me/bootstrap

# Dashboard overview
curl -b cookies.txt http://localhost:4000/api/v1/dashboard/overview
```

## Key endpoints

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me/bootstrap`, `GET /me/sessions` |
| Invitations | `POST /team/invitations`, `GET /invitations/preview`, `POST /invitations/accept`, `POST /invitations/:id/resend|revoke` |
| IAM | `GET /iam/permissions`, `GET/POST /iam/roles`, `PATCH /iam/roles/:id`, `PATCH /iam/roles/:id/permissions`, `POST/DELETE /iam/role-assignments` |
| Team | `GET /team/members`, `PATCH /team/members/:id/status|roles`, `DELETE /team/members/:id` |
| Commerce | `GET /products`, `/products/:id(/variants|/metrics)`, `/customers`, `/orders`, `/inventory(/movements)` |
| Dashboard/Analytics | `GET /dashboard/overview|navigation`, `/analytics/sales|products|customers|inventory` |
| Predictions | `GET /predictions/latest|runs|insights`, `POST /predictions/run`, `PATCH /predictions/insights/:id` |
| Stores/Integrations | `GET/POST /stores`, `GET /integrations/providers`, `POST /integrations/:provider/connect`, `POST /integrations/:id/sync`, `POST /webhooks/:provider` |
| Files | `POST /files/upload-url|complete-upload`, `GET /files/:id/download-url`, `DELETE /files/:id` |

## How tenant isolation works

Every request flows through `AuthGuard` → `PermissionsGuard`:

1. `AuthGuard` verifies the JWT, then re-checks the live session, tenant status, and that the JWT's `rbac_version` / `membership_permission_version` still match the database. A stale token returns `401 token_stale` so the client refreshes and picks up new permissions immediately.
2. `PermissionsGuard` enforces `@RequirePermissions(...)`.
3. Repositories run inside `prisma.withTenantContext(ctx, tx => ...)`, which sets `app.current_tenant_id/user_id/membership_id` per transaction so the RLS policies in `prisma/sql/setup.sql` apply.

### Hardening RLS (recommended for production)

Supabase's pooled `postgres` role **bypasses RLS**, so the policies are a safety net only while you connect as that role. The app is still correct because every repository filters by `tenant_id` explicitly. To make the DB-level backstop active, create a dedicated non-superuser role, grant it `USAGE`/CRUD on the `app` schema, and point `DATABASE_URL` at it.

## Permission toggle (near real-time)

`PATCH /iam/roles/:id/permissions` calls the `app.set_role_permissions(...)` stored procedure, which atomically rewrites `role_permissions`, bumps `tenants.rbac_version`, and bumps `membership_permission_version` for every affected member. Their next request gets `401 token_stale` → `POST /auth/refresh` → `GET /me/bootstrap` re-renders the UI.

## Background workers (optional)

Connector sync, analytics rollups, and prediction jobs are designed to run on BullMQ + Redis. For convenience the sync and prediction endpoints run **inline** (synchronously) when `REDIS_URL` is empty, so the system is fully functional without Redis. Set `REDIS_URL` to move them to the worker.

## Project layout

```
prisma/schema/        Prisma models (one file per domain) — all mapped to schema "app"
prisma/sql/setup.sql  RLS policies, functions, triggers, stored procedures (run after db push)
prisma/seed/          Permissions, role templates, providers, demo tenant
src/shared/           config, database (Prisma + tenant context), security, rbac, emails, storage, connectors, audit
src/common/           guards, decorators, interceptors, filters, pipes, pagination, cookies
src/modules/          auth, invitations, iam, team, stores, catalog, customers, orders,
                      inventory, dashboard, analytics, predictions, files, integrations
```
