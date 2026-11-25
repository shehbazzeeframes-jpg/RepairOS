/**
 * Safety net for transactions that Postgres aborts because of a lock cycle (40P01 deadlock_detected) or a
 * serialization failure (40001). The lock order in `packages/db/README.md` ("Lock order") is what prevents
 * deadlocks; this only turns a rare leftover one into a short delay instead of a 500.
 */

/** SQLSTATEs that mean "nothing was written, run the whole transaction again". */
export const RETRYABLE_SQLSTATES = ['40P01', '40001'] as const;
export type RetryableSqlState = (typeof RETRYABLE_SQLSTATES)[number];

/** Retries after the first attempt (so at most 3 attempts in all). */
export const TX_MAX_RETRIES = 2;

/**
 * Throw this inside a transaction to have it rolled back and run again (counts as a retry). Used when a row read
 * before taking the locks changed before the locks were granted (e.g. a ticket moved to another customer), so the
 * locks taken are not the ones the lock order needs.
 */
export class TxRetryError extends Error {
  override name = 'TxRetryError';
  constructor(readonly reason: string) {
    super(`Transaction must be retried: ${reason}`);
  }
}

/**
 * The retryable SQLSTATE behind an error, or null. Prisma reports it in several shapes: P2034 ("write conflict or a
 * deadlock") for model queries, P2010 with `meta.code` for raw queries, or an unknown request error whose message
 * holds the code / Postgres text.
 */
export function retryableSqlState(err: unknown): RetryableSqlState | 'retry' | null {
  if (err instanceof TxRetryError) return 'retry';
  if (!(err instanceof Error)) return null;
  const e = err as Error & { code?: unknown; meta?: { code?: unknown } };
  const metaCode = e.meta?.code;
  if (metaCode === '40P01' || metaCode === '40001') return metaCode;
  const m = /\b(40P01|40001)\b/.exec(e.message);
  if (m) return m[1] as RetryableSqlState;
  if (/deadlock detected/i.test(e.message)) return '40P01';
  if (/could not serialize access/i.test(e.message)) return '40001';
  if (e.code === 'P2034') return /deadlock/i.test(e.message) ? '40P01' : '40001';
  return null;
}

export interface TxRetryInfo {
  /** 1 for the first retry. */
  attempt: number;
  maxRetries: number;
  sqlState: RetryableSqlState | 'retry';
  delayMs: number;
  error: unknown;
}

export interface TxRetryOptions {
  maxRetries?: number;
  /** Called before each retry (the API logs it at warn). */
  onRetry?: (info: TxRetryInfo) => void;
  /** Base delay; the wait before retry n is a random value in [base·n, 2·base·n). */
  baseDelayMs?: number;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `attempt()` (one whole transaction) and runs it again, with jitter, when it fails with a retryable error.
 * `attempt` must start a NEW transaction each time and have no effect outside it (anything that must happen once,
 * like queueing an email, goes in `afterCommit` or after the call).
 */
export async function withTxRetry<T>(attempt: () => Promise<T>, opts: TxRetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? TX_MAX_RETRIES;
  const base = opts.baseDelayMs ?? 20;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      const sqlState = retryableSqlState(err);
      if (sqlState === null || n >= maxRetries) throw err;
      const delayMs = Math.floor(base * (n + 1) * (1 + random()));
      opts.onRetry?.({ attempt: n + 1, maxRetries, sqlState, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
