import { describe, expect, it } from 'vitest';
import { retryableSqlState, TxRetryError, withTxRetry, type TxRetryInfo } from './retry';

function prismaError(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name, ...extra });
}

const deadlockRaw = prismaError('PrismaClientKnownRequestError', 'Raw query failed. Code: `40P01`. Message: `deadlock detected`', {
  code: 'P2010',
  meta: { code: '40P01', message: 'deadlock detected' },
});
const serializationModel = prismaError(
  'PrismaClientKnownRequestError',
  'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
  { code: 'P2034' },
);
const deadlockUnknown = prismaError('PrismaClientUnknownRequestError', 'Error occurred during query execution: ... code: "40P01", message: "deadlock detected" ...');

describe('retryableSqlState', () => {
  it('recognises deadlocks and serialization failures in every Prisma shape', () => {
    expect(retryableSqlState(deadlockRaw)).toBe('40P01');
    expect(retryableSqlState(deadlockUnknown)).toBe('40P01');
    expect(retryableSqlState(serializationModel)).toBe('40P01');
    expect(retryableSqlState(prismaError('PrismaClientKnownRequestError', 'x', { code: 'P2034' }))).toBe('40001');
    expect(retryableSqlState(prismaError('PrismaClientUnknownRequestError', 'could not serialize access due to concurrent update'))).toBe('40001');
    expect(retryableSqlState(new TxRetryError('moved'))).toBe('retry');
  });

  it('ignores everything else (constraint errors, unique violations, plain errors)', () => {
    expect(retryableSqlState(prismaError('PrismaClientKnownRequestError', 'Unique constraint failed', { code: 'P2002' }))).toBeNull();
    expect(retryableSqlState(prismaError('PrismaClientKnownRequestError', 'Foreign key constraint failed', { code: 'P2003' }))).toBeNull();
    expect(retryableSqlState(new Error('CUSTOMER_HAS_OPEN_TICKETS'))).toBeNull();
    expect(retryableSqlState('40P01')).toBeNull();
  });
});

describe('withTxRetry', () => {
  const noSleep = { sleep: async () => undefined, random: () => 0.5 };

  it('runs the attempt again after a deadlock and returns its result; reports each retry', async () => {
    const retries: TxRetryInfo[] = [];
    let calls = 0;
    const result = await withTxRetry(
      async () => {
        calls++;
        if (calls < 3) throw deadlockRaw;
        return 'ok';
      },
      { ...noSleep, onRetry: (i) => retries.push(i) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(retries.map((r) => [r.attempt, r.maxRetries, r.sqlState])).toEqual([
      [1, 2, '40P01'],
      [2, 2, '40P01'],
    ]);
  });

  it('gives up after 2 retries and throws the last error', async () => {
    let calls = 0;
    await expect(
      withTxRetry(async () => {
        calls++;
        throw serializationModel;
      }, noSleep),
    ).rejects.toBe(serializationModel);
    expect(calls).toBe(3);
  });

  it('never retries a non-retryable error', async () => {
    let calls = 0;
    const err = new Error('boom');
    await expect(
      withTxRetry(async () => {
        calls++;
        throw err;
      }, noSleep),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it('waits with jitter that grows with the attempt', async () => {
    const waits: number[] = [];
    let calls = 0;
    let r = 0;
    const randoms = [0, 0.99];
    await withTxRetry(
      async () => {
        if (++calls < 3) throw deadlockRaw;
      },
      { sleep: async (ms) => void waits.push(ms), random: () => randoms[r++]!, baseDelayMs: 20 },
    );
    expect(waits[0]).toBe(20); // [20, 40) for the first retry
    expect(waits[1]).toBeGreaterThanOrEqual(40);
    expect(waits[1]).toBeLessThan(80); // [40, 80) for the second
  });
});
