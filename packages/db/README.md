# @repairos/db

Prisma schema, migrations, seed and the tenant-scoped client for RepairOS.

## Commands

| From the repo root | What it does |
|---|---|
| `pnpm db:migrate` | `prisma migrate deploy` + `prisma generate` + set the `repairos_app` password from `APP_DATABASE_URL` |
| `pnpm db:seed` | Idempotent dev seed (see below) |
| `pnpm db:seed:perf` | Perf dataset (50k customers, 100k tickets) in the dev/scratch DB; NOT part of `db:seed` (see `PERF.md`) |
| `pnpm --filter @repairos/db perf:explain` | EXPLAIN ANALYZE of the list/search queries on that dataset, as the app role |
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

Sprint 2 (`src/seed-tickets.ts`): both shops get the default ticket statuses and settings, then demo repair data:
36 customers / 45 devices / 44 tickets (T-1001 to T-1044) in the US shop and 8 / 9 / 9 in the PK shop, across every
status (incl. overdue, urgent, unassigned, a deactivated assignee, cancelled with a reason, two warranty tickets),
with issues, checklists, accessories, notes and timeline events. US phones are fictional `555-01xx` numbers, PK
phones `+92 3xx`. With a valid `FIELD_ENCRYPTION_KEY`, PIN/pattern devices get an encrypted passcode (try "Show
passcode" on an open ticket). **Re-running replaces all customers, devices and tickets of these two shops** and
resets their ticket counter to 1001.

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
| tenant | every model with a `shopId` field, **derived from the Prisma DMMF** (today: Location, Membership, TaxRate, AuditLog, Invitation, BusinessHours, TimeEntry, the 12 Sprint 2 tables and `TicketIdempotencyKey`) | `shopId` injected/enforced |
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

Prisma cannot express these, so they live only in the migrations. Keep them if a later
`prisma migrate dev` proposes dropping them:

| Index | Guarantees |
|---|---|
| `invitations_pending_email_key` | one PENDING invite per `(shopId, lower(email))` |
| `time_entries_one_open_key` | one open time entry (`clockOutAt IS NULL`) per `(shopId, userId)` |
| `tax_rates_default_goods_key` / `tax_rates_default_services_key` | one default goods / services rate per shop |
| `customer_phones_one_primary_key` / `customer_phones_one_whatsapp_key` | one primary and at most one WhatsApp phone per customer |
| `ticket_statuses_name_key` | status names unique per shop, case-insensitively |
| `customers_active_name_idx`, `customers_active_last_visit_idx`, `devices_imei_idx`, `devices_serial_idx`, `devices_*_trgm_idx`, `tickets_warranty_idx` | partial query indexes (see `PERF.md`) |

`customers."searchText"` is a `GENERATED ALWAYS` column (Prisma: `@ignore`). `prisma migrate diff` reports it as
`ALTER COLUMN "searchText" DROP DEFAULT`: that is the generation expression; never apply it.

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

## Sprint 2 data (customers, devices, tickets)

Migration `20261201090000_sprint2_customers_tickets`. Read with `docs/stories/sprint2-customers-and-tickets.md` and
`PERF.md`.

Migration `20261202090000_ticket_idempotency_keys` adds `ticket_idempotency_keys` (tenant table, RLS): one row per
(shop, user, `Idempotency-Key`) for POST /api/tickets. The API inserts it first in the check-in transaction with
`ON CONFLICT DO NOTHING` (a concurrent duplicate waits, then finds the committed row and returns that ticket); a key
older than `IDEMPOTENCY_WINDOW_MINUTES` is deleted and reused. Rows are small and never read after 10 minutes; the
worker deletes them daily (below).

Migration `20261203100000_daily_maintenance` adds the two functions the worker's daily `maintenance` queue calls as
the app role **without a shop context** (so they are SECURITY DEFINER and act on every shop; fixed, idempotent
clean-ups that return a count only):

| Function / helper | What |
|---|---|
| `app_sweep_unused_passcodes(minAge)` / `sweepUnusedPasscodes(db)` | Code review H1 backstop: deletes the passcode of every device with no non-closed ticket in shops with `deletePasscodeOnClose` on (passcodes set < 1 h ago are left alone). Locks each device (`SKIP LOCKED`) and re-checks; writes `passcode_deleted` on the device's last closed ticket |
| `app_purge_ticket_idempotency_keys(olderThan)` / `purgeExpiredIdempotencyKeys(db, minutes)` | Deletes idempotency keys older than the window (never younger than 10 minutes) |

### Rules built into the schema

- **Same-shop references.** Child rows reference parents through composite FKs `(shopId, parentId)` →
  `(shopId, id)`, so a row can never point at another shop's customer, device, status, ticket or note, even through
  a bug that bypasses the scoped client (FK checks bypass RLS). A ticket's device must belong to the ticket's customer
  (`(shopId, customerId, deviceId)` → devices); its assignee and note authors must be members of the shop
  (`(userId, shopId)` → memberships).
- **The denormalised status category cannot drift.** `tickets (shopId, statusId, statusCategory)` references
  `ticket_statuses (shopId, id, category)` `ON UPDATE CASCADE`: changing a status's category re-categorises its
  tickets in the same statement. `CHECK ((statusCategory = 'CLOSED') = (closedAt IS NOT NULL))` also refuses moving
  an in-use status to/from CLOSED (the API maps that to `STATUS_IN_USE`).
- **Leakproof filter columns.** `statusCategory` / `category` are `text` + `CHECK` (values = contracts
  `STATUS_CATEGORIES`; db exports `TICKET_STATUS_CATEGORIES`), not enums: under RLS an enum `=` cannot be an index
  condition (`PERF.md`, finding 1).
- **Append-only.** The app role cannot `UPDATE`/`DELETE` `ticket_events`, nor `UPDATE` `customer_consent_events`
  (erasure deletes consent history, so `DELETE` stays).
- **CHECKs**: E.164 phones (`digits` = e164 without `+`), IMEI 15 digits, serial `[A-Z0-9]{4,30}`, passcode columns
  all-or-nothing and only for PIN/PASSWORD/PATTERN, ticket prefix `[A-Z-]{0,5}`, turnaround 0-30, erased ⇒ archived,
  ≤ 10 tags, note body 1-2000.

### Database functions

| Function | Security | Use |
|---|---|---|
| `app_ensure_ticket_defaults(shopId)` | invoker (RLS applies) | Inserts the 9 default statuses (mirrors contracts `DEFAULT_TICKET_STATUSES`; `apps/api/test/sprint2-db.test.ts` fails if they drift) and the settings row, if missing. Called by the migration backfill, `ShopsService.create` and the seed |
| `app_search_customers(q, e164, includeArchived, limit, matchDevices)` | DEFINER, scoped to `app_current_shop_id()` | Customer ids + score (name/email words, phone exact/substring, IMEI/serial) |
| `app_search_devices(q, limit)` | DEFINER, scoped | Device ids + owner + score by IMEI/serial |
| `app_erase_customer(customerId)` | DEFINER, scoped | Anonymises a customer (A11) and replaces the customer's names, email, address, postcode, IMEI/serial and phones (any common format) with `[erased]` in ticket text, issue labels, notes, timeline data and audit payloads (A11-b). Matching rules and the over-matching trade-off (whole words, 2+ characters; single names only in the customer's own records) are documented at the top of migration `20261203090000_erase_redacts_free_text` |
| `app_redact_text`, `app_redact_jsonb`, `app_erase_*_pattern`, `app_erase_may_match`, `app_regex_escape` | invoker, not granted to the app role | Helpers of `app_erase_customer` |
| `f_unaccent(text)`, `app_like_escape(text)` | immutable helpers | Search normalisation |

Every DEFINER function pins `search_path = pg_catalog, public, pg_temp` (checked by `apps/api/test/schema.test.ts`)
and returns nothing without a shop context.

### TypeScript helpers (`@repairos/db`)

All take the transaction client of `tenantDb(...).tx(fn)` (type `RawSqlTx`), so they run in the caller's transaction:

| Helper | What |
|---|---|
| `nextTicketNumber(tx, shopId)` | Gapless number: `UPDATE shop_ticket_settings SET "nextNumber" = "nextNumber" + 1 ... RETURNING`; rolls back with the transaction |
| `ensureTicketDefaults(tx, shopId)` | Calls `app_ensure_ticket_defaults` |
| `customerSearchSql` / `searchCustomers`, `deviceSearchSql` / `searchDevices`, `ticketSearchSql` / `searchTickets` | Parameterised search SQL (`SELECT "id", "score"` subqueries to join into list queries) |
| `eraseCustomer(tx, customerId)` | Calls `app_erase_customer`; throws `EraseCustomerError` (`CUSTOMER_NOT_FOUND`, `CUSTOMER_ERASED`, `CUSTOMER_HAS_OPEN_TICKETS` + count); returns counts for the `customer.erased` audit event |
| `parseFieldKeyring`, `encryptField`, `decryptField`, `passcodeAad`, `passcodeColumns`, `passcodeFromRow`, `needsReencryption`, `CLEARED_PASSCODE_COLUMNS` | Passcode encryption (below) |
| `TicketEventDataByType` | What `ticket_events.data` stores per event type (ids only, resolved into the contract's `TicketTimelineItem` at read time) |

### Passcode encryption (A15)

AES-256-GCM, 96-bit random IV, 128-bit tag, stored as `passcodeCiphertext` / `passcodeIv` / `passcodeTag` (bytea) +
`passcodeKeyVersion`. Encrypt with AAD `passcodeAad(shopId, deviceId)` so a ciphertext copied to another device or
shop does not decrypt. Patterns are encrypted as contracts `formatPattern(p)` ("1-5-9-6").

`FIELD_ENCRYPTION_KEY` is one base64 32-byte key (`openssl rand -base64 32`, version 1) or, for rotation,
`v2:<new>,v1:<old>` (current first): old values keep decrypting, and `needsReencryption()` finds them for a
re-encryption script (tooling out of scope). The API's `loadConfig` refuses to start in production with a missing,
placeholder, short or malformed key; in development/test an unset or placeholder key gives
`config.fieldEncryption = null`. Key bytes are never on the keyring object (so not in logs or config dumps).

### Contract → column map

| Contract (packages/contracts) | Table.column |
|---|---|
| `CustomerDetail.kind/firstName/lastName/businessName/businessContactName/displayName/email` | `customers.*` (same names; `email` stored lower-cased) |
| `addressLine1/addressLine2/city/region/postcode/notes/tags/preferredChannel/serviceOptOut*` | `customers.*` (same names; `preferredChannel` is null only after erasure) |
| `openTicketCount/lastVisitAt/archivedAt/version/createdBy.userId` | `customers.openTicketCount/lastVisitAt/archivedAt/version/createdByUserId` |
| `ConsentSummary` (current state) | `customers.marketingSmsAt/marketingEmailAt/marketingWhatsappAt` (granted-at, null = not granted) + latest `customer_consent_events` row per channel for `source`/`recordedBy` |
| `ConsentEvent.channel/purpose/state/source/note/recordedBy.userId/createdAt` | `customer_consent_events.*` (`recordedByUserId`) |
| `CustomerPhone.e164/label/isPrimary/position`, `CustomerDetail.whatsappPhoneId` | `customer_phones.*`; `whatsappPhoneId` = id of the phone with `isWhatsapp` |
| `Device.type/brand/model/colour/imei/serial/notes/lockType/archivedAt/createdAt/updatedAt` | `devices.*` |
| `Device.passcodeOnFile/passcodeSetAt/passcodeViewCount/passcodeLastViewedAt/passcodeLastViewedBy` | `passcodeCiphertext IS NOT NULL`, `passcodeSetAt`, `passcodeViewCount`, `passcodeLastViewedAt`, `passcodeLastViewedByUserId` |
| `TicketStatus.name/category/systemRole/colour/position/isHidden/notifyCustomer/requiresNote` | `ticket_statuses.*` |
| `TicketSettings.defaultTurnaroundDays/numberPrefix/nextNumber/deletePasscodeOnClose` | `shop_ticket_settings.*`; `highestUsedNumber` = `max(tickets.number)` |
| `TicketDetail.number/priority/statusChangedAt/dueAt/dueHasTime/closedAt/cancelReason/cancelNote/reopenCount/version` | `tickets.*` |
| `status` / `statusBeforeClose` (StatusRef) | `tickets.statusId` (+ `statusCategory`) / `tickets.statusIdBeforeClose` |
| `estimate` (Money `{ amountMinor, currency }`) | `tickets.estimateMinor` + `tickets.currency` (shop currency snapshot) |
| `CreateTicketInput.warrantyOfTicketId`, `TicketDetail.warrantyOf` / `warrantyTickets` | `tickets.warrantyOfTicketId` (and its reverse) |
| `CancelTicketInput.returnedConfirmed` | `tickets.returnedConfirmed` |
| `assignee` (UserRef) | `tickets.assigneeUserId` |
| `issues` (`{ code, label }[]`) | `ticket_issues (code, label, position)` |
| `checklist` (`Record<ChecklistItemKey, ChecklistResult>`) | `ticket_checklist_items (itemKey, result, position)` |
| `accessories` (`AccessoryCode[]`), `accessoriesOther` | `ticket_accessories.code`, `tickets.accessoriesOther` |
| `description`, `conditionNotes`, `createdBy.userId` | `tickets.description/conditionNotes/createdByUserId` |
| `TicketNote.body/visibility/author.userId/createdAt/editedAt` | `ticket_notes.*` (`authorUserId`) |
| `TicketTimelineItem.type/actor/createdAt/data` | `ticket_events.type` (same enum values) / `actorUserId` / `createdAt` / `data` per `TicketEventDataByType`; `note_added.data.note` and `status_changed.data.noteId` come from `ticket_events.noteId` |
