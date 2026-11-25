import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '@prisma/client';
import { scopeArgs } from './scope-args';

/**
 * Tenant context for a request. `userId` is optional and only widens what RLS lets the
 * transaction *read* (the user's own memberships and the shops they belong to).
 */
export interface TenantContext {
  shopId: string;
  userId?: string | null;
}

/** Marks code that already runs inside a transaction where app.shop_id was SET LOCAL. */
const tenantTxStore = new AsyncLocalStorage<{ shopId: string }>();

/** `SELECT set_config(..., true)` = SET LOCAL: the values vanish when the transaction ends. */
function setConfigSql(shopId: string, userId: string | null | undefined): Prisma.Sql {
  return Prisma.sql`SELECT set_config('app.shop_id', ${shopId}, true), set_config('app.user_id', ${userId ?? ''}, true)`;
}

/**
 * Prisma client extension that scopes every query on tenant models to one shop:
 *  - injects `shopId` (or `id` for Shop) into `where` and `create` data;
 *  - rejects creates/updates that point at another shop;
 *  - runs each top-level operation in a transaction that first sets `app.shop_id`
 *    (and `app.user_id`) with SET LOCAL, so Postgres Row-Level Security applies as a backstop.
 *
 * Inside `tenantDb(...).tx(fn)` operations are not wrapped again: the interactive transaction
 * has already set the config.
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

export type ScopedClient = ReturnType<typeof scopedClient>;
type TxFn = Parameters<ScopedClient['$transaction']>[0];
/** The transaction client handed to `tenantDb(...).tx(fn)`. */
export type ScopedTx = TxFn extends (tx: infer T) => unknown ? T : never;
export interface TxOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

export function scopedClient(base: PrismaClient, ctx: TenantContext) {
  return base.$extends(forShop(ctx.shopId, { userId: ctx.userId }));
}

/**
 * The scoped data access entry point used by the API.
 *
 *   const db = tenantDb(prisma, { shopId, userId });
 *   await db.client.taxRate.findMany();                // one query, own transaction
 *   await db.tx(async (tx) => { ...several writes... });  // one transaction, SET LOCAL once
 */
export function tenantDb(base: PrismaClient, ctx: TenantContext) {
  const client = scopedClient(base, ctx);
  return {
    ctx,
    client,
    tx<T>(fn: (tx: ScopedTx) => Promise<T>, options?: TxOptions): Promise<T> {
      return client.$transaction(async (tx) => {
        await tx.$executeRaw(setConfigSql(ctx.shopId, ctx.userId));
        return tenantTxStore.run({ shopId: ctx.shopId }, () => fn(tx as ScopedTx));
      }, options);
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
