import { describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_JOBS, MAINTENANCE_SCHEDULES, processMaintenanceJob, scheduleMaintenance } from './maintenance-jobs';

describe('maintenance jobs', () => {
  it('schedules the passcode sweep and the idempotency-key purge once a day (UTC)', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await scheduleMaintenance({ upsertJobScheduler } as never);
    expect(upsertJobScheduler.mock.calls.map((c) => [c[0], c[2].name])).toEqual([
      ['daily-passcode-sweep', MAINTENANCE_JOBS.passcodeSweep],
      ['daily-idempotency-key-purge', MAINTENANCE_JOBS.idempotencyKeyPurge],
    ]);
    for (const s of MAINTENANCE_SCHEDULES) expect(s.pattern).toMatch(/^\d+ \d+ \* \* \*$/); // daily
    for (const c of upsertJobScheduler.mock.calls) expect(c[1]).toMatchObject({ tz: 'UTC' });
  });

  it('runs each job through its database call and rejects unknown jobs', async () => {
    const deps = { sweepPasscodes: vi.fn().mockResolvedValue(3), purgeIdempotencyKeys: vi.fn().mockResolvedValue(7), logger: { info: vi.fn() } };
    await expect(processMaintenanceJob({ id: '1', name: MAINTENANCE_JOBS.passcodeSweep }, deps)).resolves.toEqual({ deleted: 3 });
    await expect(processMaintenanceJob({ id: '2', name: MAINTENANCE_JOBS.idempotencyKeyPurge }, deps)).resolves.toEqual({ deleted: 7 });
    expect(deps.sweepPasscodes).toHaveBeenCalledTimes(1);
    expect(deps.purgeIdempotencyKeys).toHaveBeenCalledTimes(1);
    await expect(processMaintenanceJob({ id: '3', name: 'nope' }, deps)).rejects.toThrow(/No processor/);
  });
});
