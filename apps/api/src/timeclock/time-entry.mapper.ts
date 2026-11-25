import { LONG_SHIFT_MINUTES, type TimeEntry } from '@repairos/contracts';
import type { TimeEntry as TimeEntryRow } from '@repairos/db';
import { localDateOf } from '../common/time';

export interface EntryContext {
  timeZone: string;
  now: Date;
  /** Shop-local date of `now`. */
  today: string;
  /** userId → name, for "edited by". */
  names: Map<string, string>;
}

export function durationMinutes(row: Pick<TimeEntryRow, 'clockInAt' | 'clockOutAt'>, now: Date): number {
  const end = row.clockOutAt ?? now;
  return Math.max(0, Math.floor((end.getTime() - row.clockInAt.getTime()) / 60_000));
}

export function toTimeEntryDto(row: TimeEntryRow, ctx: EntryContext): TimeEntry {
  const localDate = localDateOf(row.clockInAt, ctx.timeZone);
  const minutes = durationMinutes(row, ctx.now);
  return {
    id: row.id,
    userId: row.userId,
    clockInAt: row.clockInAt.toISOString(),
    clockOutAt: row.clockOutAt?.toISOString() ?? null,
    localDate,
    durationMinutes: minutes,
    source: row.source,
    closedReason: row.closedReason,
    flaggedLong: minutes > LONG_SHIFT_MINUTES,
    // Open and its shop-local start day has ended.
    stillOpen: row.clockOutAt === null && localDate < ctx.today,
    edited:
      row.editedAt && row.editReason !== null
        ? {
            at: row.editedAt.toISOString(),
            byUserId: row.editedByUserId,
            byName: row.editedByUserId ? (ctx.names.get(row.editedByUserId) ?? null) : null,
            reason: row.editReason,
          }
        : null,
  };
}
