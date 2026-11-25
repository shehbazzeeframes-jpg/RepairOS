/** Helpers for race tests: hold row locks in an owner-role transaction while an API request runs into them. */
import type { PrismaClient, Prisma } from '@repairos/db';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `hold(tx)` in an owner-role transaction (locks rows / writes uncommitted changes), starts `request()` while
 * the transaction is still open, waits `holdMs`, commits, then returns the request's result. The request therefore
 * either reads the pre-commit state (no lock taken) or waits for the commit (row lock taken).
 */
export async function whileLocked<T>(
  adminDb: PrismaClient,
  hold: (tx: Prisma.TransactionClient) => Promise<unknown>,
  request: () => PromiseLike<T>,
  holdMs = 700,
): Promise<T> {
  let pending: Promise<T> | undefined;
  await adminDb.$transaction(
    async (tx) => {
      await hold(tx);
      pending = (async () => await request())();
      pending.catch(() => undefined);
      await sleep(holdMs);
    },
    { timeout: 30_000 },
  );
  return pending!;
}

/**
 * Like `whileLocked`, but a second step runs in the SAME owner transaction once the request has had `waitMs` to run
 * into the held locks: `then(tx)` can take a lock the request already holds (a lock cycle → Postgres aborts the
 * transaction that waited first, i.e. the request) or run a statement that waits for it. The transaction commits
 * `holdMs` after `then` returns. Returns the request's result.
 */
export async function whileLockedThen<T>(
  adminDb: PrismaClient,
  hold: (tx: Prisma.TransactionClient) => Promise<unknown>,
  request: () => PromiseLike<T>,
  then: (tx: Prisma.TransactionClient) => Promise<unknown>,
  opts: { waitMs?: number; holdMs?: number } = {},
): Promise<T> {
  let pending: Promise<T> | undefined;
  await adminDb.$transaction(
    async (tx) => {
      await hold(tx);
      pending = (async () => await request())();
      pending.catch(() => undefined);
      await sleep(opts.waitMs ?? 400);
      await then(tx);
      await sleep(opts.holdMs ?? 300);
    },
    { timeout: 30_000 },
  );
  return pending!;
}
