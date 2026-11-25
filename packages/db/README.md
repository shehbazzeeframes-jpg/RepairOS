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

Every demo user's password is `Password123!`.

| Shop | Country | Users |
|---|---|---|
| Demo Phone Repair | US | `owner@demo.test` (Owner), `manager@demo.test` (Manager), `frontdesk@demo.test` (Front desk), `tech@demo.test` (Technician), `former@demo.test` (Technician, **deactivated**: sees the "access removed" state) |
| Lahore Mobile Clinic | PK | `owner.pk@demo.test` (Owner) |

The US shop also gets a pending invite for `new.hire@demo.test` (its token is random and unknown: use
"Resend" or "Copy invite link" to get a working link), about two weeks of time entries (one 14h45m
"Long shift", one closed on deactivation, one manual correction) and the audit events of those actions.
Seed-owned time entries, invites and audit events are recreated on every run.

The PK shop is a second tenant for isolation testing (its owner is not a member of the US shop).

## Two database roles

| Env var | Role | Used by | RLS |
|---|---|---|---|
| `DATABASE_URL` | `repairos` (table owner) | migrations, seed | bypassed (table owner) |
| `APP_DATABASE_URL` | `repairos_app` | API (and later the worker) | **enforced** |

The migration `*_rls_app_role` creates `repairos_app` (`LOGIN NOSUPERUSER NOBYPASSRLS`, no password),
grants it `SELECT/INSERT/UPDATE/DELETE` on all tables (plus default privileges for tables created by later
migrations), revokes access to `_prisma_migrations`, and revokes `UPDATE/DELETE` on `audit_logs`
(append-only). `*_audit_log_restrict` revokes `DELETE` on `shops` (deleting a shop would cascade its data
away) and makes `audit_logs.shopId` `ON DELETE RESTRICT`, so audit history also blocks owner-role deletes. `scripts/sync-app-role.ts` (part of `db:migrate`) sets the role's password from
`APP_DATABASE_URL`, so the password lives only in `.env`. Roles are cluster-wide, so
`APP_DATABASE_URL` and `APP_DATABASE_URL_TEST` must use the same password.

The API calls `assertAppRole()` at startup and refuses to start if its role is a superuser, has
`BYPASSRLS`, or owns the `shops` table. `APP_DATABASE_URL` is required (no fallback to `DATABASE_URL`).

In production, run migrations as the owner role and give the API only `APP_DATABASE_URL`. If the
migration user cannot `ALTER ROLE`, set the password out of band and leave `APP_DATABASE_URL` unset
when running `db:migrate` (the sync step is skipped).

## Tenancy: two layers

Every Prisma model is classified in `src/models.ts` (a unit test fails on any unclassified model):

| Kind | Models | Scoped client behaviour |
|---|---|---|
| tenant | every model with a `shopId` field, **derived from the Prisma DMMF** (today: Location, Membership, TaxRate, AuditLog, Invitation, BusinessHours, TimeEntry) | `shopId` injected/enforced |
| shop | `Shop` | scoped by `id` |
| auth | `User`, `Session`, `Account`, `Verification` | `Session`/`Account`/`Verification` throw; `User` is read-only and limited to members of the current shop |
| global | none yet (`GLOBAL_MODELS`) | unchanged |

Auth tables are only touched through the base client, by Better Auth and the API's auth guard.

### 1. `forShop(shopId)` Prisma extension (application layer)

`src/scope-args.ts` rewrites the args of every operation on a tenant model:

- `where` gets `AND: [{ shopId }]` (or `{ id }` for `Shop`) on reads, counts, aggregates, updates,
  deletes and upserts. A caller filter on another shop is kept and ANDed, so it matches nothing.
- `create` / `createMany` / upsert `create` get `shopId` set; a different `shopId` or a `shop: { connect }`
  relation throws `TenantScopeError`.
- `update` data that tries to change `shopId` throws `TenantScopeError`.

A new model with `shopId` is scoped automatically. Give its table an RLS policy in the same migration
(the API test `test/schema.test.ts` fails if any table with a `shopId` column lacks RLS or a policy) and
add an isolation test. A model without `shopId` must be added to `AUTH_MODELS` or `GLOBAL_MODELS` on purpose.

### 2. Postgres Row-Level Security (backstop)

Each tenant table has `ENABLE ROW LEVEL SECURITY` and a policy
`"shopId" = app_current_shop_id()` (`USING` + `WITH CHECK`), where

```sql
app_current_shop_id() = NULLIF(current_setting('app.shop_id', true), '')
app_current_user_id() = NULLIF(current_setting('app.user_id', true), '')
```

Two extra read-only policies let a user see *their own* memberships and the shops they belong to
(needed for `/api/me` and the shop switcher before a shop is chosen):
`memberships_self_read` (`"userId" = app_current_user_id()`, any status, so `/api/me` can report
`accessRemoved`) and `shops_member_read` (only through an **ACTIVE** membership, Sprint 1 Risk #1).

`app_invitation_by_token_hash(hash)` is a `SECURITY DEFINER` function that maps an invite token hash to
`(id, shopId)` only, for the public invite page (no shop context yet). The API then reads the invite
through the scoped client for that shop.

### Partial unique indexes (hand-written SQL)

Prisma cannot express these, so they live only in the Sprint 1 migration. Keep them if a later
`prisma migrate dev` proposes dropping them:

| Index | Guarantees |
|---|---|
| `invitations_pending_email_key` | one PENDING invite per `(shopId, lower(email))` |
| `time_entries_one_open_key` | one open time entry (`clockOutAt IS NULL`) per `(shopId, userId)` |
| `tax_rates_default_goods_key` / `tax_rates_default_services_key` | one default goods / services rate per shop |

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

// Several operations, atomically: set_config runs once, then fn(tx).
// AsyncLocalStorage holds the transaction: inside fn, `db.client` (and any tenantDb for the same shop)
// is routed to `tx`, so it sees the uncommitted writes and rolls back with them.
await db.tx(async (tx) => {
  await tx.location.create({ data: { shopId, name: 'Main' } });
  await tx.auditLog.create({ data: { shopId, action: 'x', entityType: 'Shop', entityId: shopId } });
});

// Cross-shop reads for one user (memberships list), no shop selected:
await userTx(prisma, userId, (tx) => tx.membership.findMany({ where: { userId } }));
```

`db.client` exposes model delegates only: `$transaction`, `$queryRaw*`, `$executeRaw*`, `$extends`,
`$connect`/`$disconnect` throw (`$transaction` on an extended client is not atomic, because every op is
wrapped in its own batch transaction on its own connection). Use `db.tx` for transactions and raw SQL.

`forShop(shopId)` is still exported as the low-level extension, but application code should use `tenantDb`.

### Known limits

- Nested writes (`shop.create({ data: { locations: { create: [...] } } })`) and `include`d relations are
  not rewritten by the extension; RLS still enforces them. Prefer flat, explicit writes.
- `$queryRaw` / `$executeRaw` bypass the extension; inside `db.tx` RLS still applies.
- A batch-wrapped single operation costs one extra round trip (`set_config`). Use `db.tx` for hot paths
  with several queries.
- Referential-integrity checks bypass RLS by design in Postgres (FKs to `shops` always validate).
