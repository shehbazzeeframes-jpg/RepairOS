import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import { withTxRetry, type TxRetryOptions } from './retry';
import { scopeArgs, TenantScopeError } from './scope-args';

/**
 * Tenant context for a request. `userId` is optional and only widens what RLS lets the
 * transaction *read* (the user's own memberships and the shops they belong to).
 */
export interface TenantContext {
  shopId: string;
  userId?: string | null;
}

/**
 * Set while `tenantDb(...).tx(fn)` runs: the shop whose app.shop_id is SET LOCAL on the
 * transaction, and the transaction client. Scoped calls for that shop are routed to `tx`.
 */
interface TenantTxState {
  shopId: string;
  tx: object;
  /** Callbacks for after the commit of this attempt (dropped if the attempt rolls back or is retried). */
  afterCommit: (() => unknown)[];
}
const tenantTxStore = new AsyncLocalStorage<TenantTxState>();

/** `SELECT set_config(..., true)` = SET LOCAL: the values vanish when the transaction ends. */
function setConfigSql(shopId: string, userId: string | null | undefined): Prisma.Sql {
  return Prisma.sql`SELECT set_config('app.shop_id', ${shopId}, true), set_config('app.user_id', ${userId ?? ''}, true)`;
}

/**
 * Low-level Prisma client extension that scopes every model query to one shop:
 *  - injects `shopId` (or `id` for Shop) into `where` and `create` data, rejects cross-shop writes,
 *    refuses auth tables (User is read-only and limited to the shop's members);
 *  - runs each top-level operation in a batch transaction that first sets `app.shop_id`
 *    (and `app.user_id`) with SET LOCAL, so Postgres Row-Level Security applies as a backstop.
 *
 * Application code should use `tenantDb()` instead: its client hides `$transaction` and raw SQL,
 * and its `tx()` gives atomic multi-statement transactions. Do not call `$transaction` on a client
 * extended with `forShop` directly: operations inside it are not atomic.
 */
export function forShop(shopId: string, opts: { userId?: string | null } = {}) {
  if (!shopId) throw new Error('forShop: shopId is required');
  return Prisma.defineExtension((client) =>
    client.$extends({
      name: 'forShop',
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const scoped = scopeArgs(model, operation, args, shopId);
            // Inside tenantDb().tx for this shop: the transaction already ran set_config.
            if (tenantTxStore.getStore()?.shopId === shopId) return query(scoped);
            const [, result] = await client.$transaction([
              client.$executeRaw(setConfigSql(shopId, opts.userId)),
              query(scoped),
            ]);
            return result;
          },
        },
      },
    }),
  );
}

function extendedClient(base: PrismaClient, ctx: TenantContext) {
  return base.$extends(forShop(ctx.shopId, { userId: ctx.userId }));
}
type ExtendedClient = ReturnType<typeof extendedClient>;
type TxFn = Parameters<ExtendedClient['$transaction']>[0];
type ExtendedTx = TxFn extends (tx: infer T) => unknown ? T : never;

/** Auth tables the scoped client refuses (User stays, read-only and shop-limited). */
type HiddenModels = 'session' | 'account' | 'verification';
/** Client members that would escape the scope or break atomicity. */
const BLOCKED_CLIENT_MEMBERS = [
  '$transaction',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRaw',
  '$queryRawUnsafe',
  '$extends',
  '$connect',
  '$disconnect',
  '$on',
  '$use',
] as const;
type BlockedMembers = (typeof BLOCKED_CLIENT_MEMBERS)[number];
const BLOCKED = new Set<PropertyKey>(BLOCKED_CLIENT_MEMBERS);

/** The client exposed as `tenantDb(...).client`: model delegates only. */
export type ScopedClient = Omit<ExtendedClient, BlockedMembers | HiddenModels>;
/** The transaction client handed to `tenantDb(...).tx(fn)`. Raw SQL is allowed here (RLS context is set). */
export type ScopedTx = Omit<ExtendedTx, HiddenModels>;

export interface TxOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** Options of `tenantDb`. */
export interface TenantDbOptions {
  /**
   * Retry of a top-level `tx()` that fails with a deadlock (40P01) or serialization failure (40001), or throws
   * `TxRetryError`: at most `maxRetries` (default 2) more attempts, with jitter. `false` turns it off.
   */
  retry?: TxRetryOptions | false;
}

/**
 * Runs `fn` once, after the current `tenantDb().tx()` has committed (immediately when called outside one). Use it for
 * side effects outside the database (queueing an email or a job): a retried attempt's callbacks are dropped with
 * its rollback, so the effect happens once, and never for a transaction that rolls back. The callback's error is
 * thrown to the caller of `tx()` (the data is already committed).
 */
export async function afterCommit(fn: () => unknown): Promise<void> {
  const state = tenantTxStore.getStore();
  if (state) state.afterCommit.push(fn);
  else await fn();
}

/**
 * The scoped data access entry point used by the API.
 *
 *   const db = tenantDb(prisma, { shopId, userId });
 *   await db.client.taxRate.findMany();                   // one query, own transaction
 *   await db.tx(async (tx) => { ...several writes... });  // atomic, SET LOCAL once
 *
 * Inside `db.tx(fn)`, `db.client` calls for the same shop are routed to the transaction,
 * so they see uncommitted writes and roll back with it.
 */
export function tenantDb(base: PrismaClient, ctx: TenantContext, opts: TenantDbOptions = {}) {
  if (!ctx.shopId) throw new Error('tenantDb: shopId is required');
  const raw = extendedClient(base, ctx);

  const client = new Proxy(raw, {
    get(target, prop) {
      if (BLOCKED.has(prop)) {
        throw new TenantScopeError(
          `tenantDb().client.${String(prop)} is not available: use tenantDb().tx(async (tx) => ...) for transactions and raw SQL`,
        );
      }
      const state = tenantTxStore.getStore();
      const source: object = state && state.shopId === ctx.shopId ? state.tx : target;
      const value: unknown = Reflect.get(source, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(source) : value;
    },
  }) as unknown as ScopedClient;

  return {
    ctx,
    client,
    tx<T>(fn: (tx: ScopedTx) => Promise<T>, options?: TxOptions): Promise<T> {
      const current = tenantTxStore.getStore();
      if (current) {
        if (current.shopId !== ctx.shopId) {
          throw new TenantScopeError('tenantDb().tx cannot be nested inside a transaction for another shop');
        }
        // Already inside a transaction for this shop: join it.
        return fn(current.tx as ScopedTx);
      }
      const attempt = async () => {
        const callbacks: (() => unknown)[] = [];
        const result = await raw.$transaction(async (tx) => {
          await tx.$executeRaw(setConfigSql(ctx.shopId, ctx.userId));
          return tenantTxStore.run({ shopId: ctx.shopId, tx, afterCommit: callbacks }, () => fn(tx as ScopedTx));
        }, options);
        return { result, callbacks };
      };
      const run = opts.retry === false ? attempt() : withTxRetry(attempt, opts.retry);
      return run.then(async ({ result, callbacks }) => {
        for (const cb of callbacks) await cb();
        return result;
      });
    },
  };
}
export type TenantDb = ReturnType<typeof tenantDb>;

/**
 * Cross-shop reads for one user (e.g. "which shops am I a member of?") with no active shop.
 * Sets only `app.user_id`; RLS then allows reading that user's memberships and their shops,
 * and nothing else in tenant tables. Do not use it for writes to tenant tables.
 */
export function userTx<T>(
  base: PrismaClient,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!userId) throw new Error('userTx: userId is required');
  return base.$transaction(async (tx) => {
    await tx.$executeRaw(setConfigSql('', userId));
    return fn(tx);
  });
}

/**
 * Refuses to run the app as a role that would bypass RLS: a superuser, a BYPASSRLS role, or the
 * owner of the tenant tables. Call once at startup with the app's client.
 */
export async function assertAppRole(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<
    { rolname: string; rolsuper: boolean; rolbypassrls: boolean; shops_exists: boolean; owns_shops: boolean }[]
  >`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls,
           (c.oid IS NOT NULL) AS shops_exists,
           COALESCE(c.relowner = r.oid, false) AS owns_shops
    FROM pg_roles r
    LEFT JOIN pg_class c ON c.relname = 'shops' AND c.relnamespace = 'public'::regnamespace
    WHERE r.rolname = current_user`;
  const r = rows[0];
  if (!r) throw new Error('assertAppRole: could not read the current database role');
  const problems = [
    r.rolsuper && 'is a superuser',
    r.rolbypassrls && 'has BYPASSRLS',
    r.owns_shops && 'owns the tenant tables',
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(
      `Refusing to start: database role "${r.rolname}" ${problems.join(', ')}, so Row-Level Security would not apply. ` +
        'Connect with APP_DATABASE_URL (role repairos_app).',
    );
  }
  if (!r.shops_exists) throw new Error('Refusing to start: table "shops" not found. Run `pnpm db:migrate`.');
}
