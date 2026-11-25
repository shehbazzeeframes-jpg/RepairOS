import type { RawSqlTx } from './tickets';

/**
 * Daily maintenance run by the worker as the app role WITHOUT a shop context. Each helper calls one
 * SECURITY DEFINER function of migration `20261203100000_daily_maintenance`, which acts on every shop and returns a
 * count only. Pass the base client (`createPrismaClient(APP_DATABASE_URL)`), not a `tenantDb`.
 */

/** Passcodes set within this window are never swept (saved on the device form just before a check-in). */
export const PASSCODE_SWEEP_MIN_AGE_MINUTES = 60;

/**
 * Code review H1 backstop: deletes the passcode of every device with no non-closed ticket, in shops with
 * "Delete passcode when the ticket closes" on (timeline `passcode_deleted` on the device's last closed ticket).
 * Returns the number of passcodes deleted.
 */
export async function sweepUnusedPasscodes(db: RawSqlTx, minAgeMinutes = PASSCODE_SWEEP_MIN_AGE_MINUTES): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT app_sweep_unused_passcodes(make_interval(mins => ${minAgeMinutes}::int)) AS n`;
  return Number(row?.n ?? 0);
}

/**
 * Deletes check-in idempotency keys older than `olderThanMinutes` (use contracts `IDEMPOTENCY_WINDOW_MINUTES`; the
 * database never deletes keys younger than 10 minutes). Returns the number of rows deleted.
 */
export async function purgeExpiredIdempotencyKeys(db: RawSqlTx, olderThanMinutes: number): Promise<number> {
  const [row] = await db.$queryRaw<{ n: number }[]>`
    SELECT app_purge_ticket_idempotency_keys(make_interval(mins => ${olderThanMinutes}::int)) AS n`;
  return Number(row?.n ?? 0);
}
