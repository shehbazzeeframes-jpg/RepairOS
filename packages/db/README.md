# @repairos/db

Prisma schema, migrations, seed and the tenant-scoped client for RepairOS.

## Commands

| From the repo root | What it does |
|---|---|
| `pnpm db:migrate` | `prisma migrate deploy` + `prisma generate` + set the `repairos_app` password from `APP_DATABASE_URL` |
| `pnpm db:seed` | Idempotent dev seed (see below) |
| `pnpm --filter @repairos/db migrate:dev` | Create/apply a new migration while developing (`prisma migrate dev`) |
| `pnpm --filter @repairos/db generate` | Regenerate the Prisma client (also runs on `pnpm install`) |

All scripts read the root `.env`.

### Seed

| Shop | Country | Owner | Password |
|---|---|---|---|
| Demo Phone Repair | US | `owner@demo.test` | `Password123!` |
| Lahore Mobile Clinic | PK | `owner.pk@demo.test` | `Password123!` |

The PK shop is a second tenant for isolation testing (its owner is not a member of the US shop).

## Two database roles

| Env var | Role | Used by | RLS |
|---|---|---|---|
| `DATABASE_URL` | `repairos` (table owner) | migrations, seed | bypassed (table owner) |
| `APP_DATABASE_URL` | `repairos_app` | API (and later the worker) | **enforced** |

The migration `*_rls_app_role` creates `repairos_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`, no password),
grants it `SELECT/INSERT/UPDATE/DELETE` on all tables (plus default privileges for tables created by later
migrations), revokes access to `_prisma_migrations`, and revokes `UPDATE/DELETE` on `audit_logs`
(append-only). `scripts/sync-app-role.ts` (part of `db:migrate`) sets the role's password from
`APP_DATABASE_URL`, so the password lives only in `.env`. Roles are cluster-wide, so
`APP_DATABASE_URL` and `APP_DATABASE_URL_TEST` must use the same password.

In production, run migrations as the owner role and give the API only `APP_DATABASE_URL`. If the
migration user cannot `ALTER ROLE`, set the password out of band and leave `APP_DATABASE_URL` unset
when running `db:migrate` (the sync step is skipped).

## Tenancy: two layers

Tenant tables: `shops` (keyed by `id`), `locations`, `memberships`, `tax_rates`, `audit_logs` (keyed by `shopId`).
Auth tables (`users`, `sessions`, `accounts`, `verifications`) are not tenant tables.

### 1. `forShop(shopId)` Prisma extension (application layer)

`src/scope-args.ts` rewrites the args of every operation on a tenant model:

- `where` gets `AND: [{ shopId }]` (or `{ id }` for `Shop`) on reads, counts, aggregates, updates,
  deletes and upserts. A caller filter on another shop is kept and ANDed, so it matches nothing.
- `create` / `createMany` / upsert `create` get `shopId` set; a different `shopId` or a `shop: { connect }`
  relation throws `TenantScopeError`.
- `update` data that tries to change `shopId` throws `TenantScopeError`.

Add every new tenant model to `TENANT_MODELS` in `src/scope-args.ts` **and** give its table an RLS
policy in the same migration, plus an isolation test.

### 2. Postgres Row-Level Security (backstop)

Each tenant table has `ENABLE ROW LEVEL SECURITY` and a policy
`"shopId" = app_current_shop_id()` (`USING` + `WITH CHECK`), where

```sql
app_current_shop_id() = NULLIF(current_setting('app.shop_id', true), '')
app_current_user_id() = NULLIF(current_setting('app.user_id', true), '')
```

Two extra read-only policies let a user see *their own* memberships and the shops they belong to
(needed for `/api/me` and the shop switcher before a shop is chosen):
`memberships_self_read` (`"userId" = app_current_user_id()`) and `shops_member_read`.

With no `app.shop_id` set, the app role sees **zero** tenant rows and cannot write any.

### How the settings are applied

The settings are transaction-local (`set_config(name, value, true)`, i.e. `SET LOCAL`), so they can never
leak to another request through the connection pool.

```ts
import { createPrismaClient, tenantDb, userTx } from '@repairos/db';

const prisma = createPrismaClient(process.env.APP_DATABASE_URL);
const db = tenantDb(prisma, { shopId, userId });

// Single operation: the extension wraps it in a batch transaction
//   [SELECT set_config('app.shop_id', ...), <query>]
await db.client.taxRate.findMany();

// Several operations in one transaction: set_config runs once, then fn(tx).
// An AsyncLocalStorage flag stops the extension from wrapping each op again.
await db.tx(async (tx) => {
  await tx.location.create({ data: { shopId, name: 'Main' } });
  await tx.auditLog.create({ data: { shopId, action: 'x', entityType: 'Shop', entityId: shopId } });
});

// Cross-shop reads for one user (memberships list), no shop selected:
await userTx(prisma, userId, (tx) => tx.membership.findMany({ where: { userId } }));
```

You can also use the raw extension: `prisma.$extends(forShop(shopId, { userId }))`.

### Known limits

- Nested writes (`shop.create({ data: { locations: { create: [...] } } })`) and `include`d relations are
  not rewritten by the extension; RLS still enforces them. Prefer flat, explicit writes.
- `$queryRaw` / `$executeRaw` bypass the extension; inside `db.tx` RLS still applies.
- A batch-wrapped single operation costs one extra round trip (`set_config`). Use `db.tx` for hot paths
  with several queries.
- Referential-integrity checks bypass RLS by design in Postgres (FKs to `shops` always validate).
