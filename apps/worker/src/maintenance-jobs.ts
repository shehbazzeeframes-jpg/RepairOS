import type { Job, Queue } from 'bullmq';
import type { Logger } from 'pino';

/** Queue for the daily clean-ups (no job data; every job acts on all shops through a SECURITY DEFINER function). */
export const MAINTENANCE_QUEUE = 'maintenance';

export const MAINTENANCE_JOBS = {
  /** Code review H1 backstop: delete passcodes no open ticket needs (shops with the setting on). */
  passcodeSweep: 'passcode-sweep',
  /** Backlog: delete `ticket_idempotency_keys` rows older than IDEMPOTENCY_WINDOW_MINUTES. */
  idempotencyKeyPurge: 'idempotency-key-purge',
} as const;
export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

/**
 * Daily, at quiet hours (UTC). Registered with `upsertJobScheduler`, so restarts and several worker instances keep
 * exactly one schedule per id.
 */
export const MAINTENANCE_SCHEDULES: readonly { id: string; name: MaintenanceJobName; pattern: string }[] = [
  { id: 'daily-passcode-sweep', name: MAINTENANCE_JOBS.passcodeSweep, pattern: '17 3 * * *' },
  { id: 'daily-idempotency-key-purge', name: MAINTENANCE_JOBS.idempotencyKeyPurge, pattern: '43 3 * * *' },
];

export async function scheduleMaintenance(queue: Pick<Queue, 'upsertJobScheduler'>): Promise<void> {
  for (const s of MAINTENANCE_SCHEDULES) {
    await queue.upsertJobScheduler(s.id, { pattern: s.pattern, tz: 'UTC' }, { name: s.name, data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } });
  }
}

export interface MaintenanceDeps {
  /** `sweepUnusedPasscodes(appRoleClient)` from @repairos/db. */
  sweepPasscodes: () => Promise<number>;
  /** `purgeExpiredIdempotencyKeys(appRoleClient, IDEMPOTENCY_WINDOW_MINUTES)` from @repairos/db. */
  purgeIdempotencyKeys: () => Promise<number>;
  logger: Pick<Logger, 'info'>;
}

/** Runs one maintenance job; returns the number of rows changed. Unknown names throw (BullMQ marks the job failed). */
export async function processMaintenanceJob(job: Pick<Job, 'id' | 'name'>, deps: MaintenanceDeps): Promise<{ deleted: number }> {
  let deleted: number;
  switch (job.name) {
    case MAINTENANCE_JOBS.passcodeSweep:
      deleted = await deps.sweepPasscodes();
      break;
    case MAINTENANCE_JOBS.idempotencyKeyPurge:
      deleted = await deps.purgeIdempotencyKeys();
      break;
    default:
      throw new Error(`No processor for maintenance job "${job.name}"`);
  }
  deps.logger.info({ jobId: job.id, job: job.name, deleted }, 'maintenance done');
  return { deleted };
}
