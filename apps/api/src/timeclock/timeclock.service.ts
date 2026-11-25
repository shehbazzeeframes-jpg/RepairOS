import { Inject, Injectable } from '@nestjs/common';
import {
  API_ERROR_MESSAGES,
  canEditTimeEntry,
  type CreateTimeEntryInput,
  csvCell,
  decimalHours,
  MAX_ENTRY_MINUTES,
  ROLE_LABELS,
  TIMESHEET_CSV_COLUMNS,
  timesheetCsvFilename,
  type TimeclockStatus,
  type TimeEntry,
  type TimesheetQuery,
  type TimesheetResponse,
  type TimesheetStaff,
  type UpdateTimeEntryInput,
} from '@repairos/contracts';
import type { Prisma, ScopedTx, TimeEntry as TimeEntryRow } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { isUniqueViolation, lockShop, writeAudit } from '../common/audit';
import { type ApiIssue, apiError, forbidden, notFound, validationFailed } from '../common/errors';
import { addDays, localDateOf, localRange, localTimeOf, mondayOf, startOfLocalDay } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';
import { type EntryContext, toTimeEntryDto } from './time-entry.mapper';

const iso = (d: Date | null) => d?.toISOString() ?? null;

function entrySnapshot(e: TimeEntryRow) {
  return { userId: e.userId, clockInAt: iso(e.clockInAt), clockOutAt: iso(e.clockOutAt), source: e.source };
}

@Injectable()
export class TimeclockService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  private async context(tx: ScopedTx, userIds: Iterable<string | null>, now = new Date()): Promise<EntryContext> {
    const shop = await tx.shop.findFirstOrThrow({ select: { timezone: true } });
    const ids = [...new Set([...userIds].filter((x): x is string => !!x))];
    const users = ids.length ? await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return { timeZone: shop.timezone, now, today: localDateOf(now, shop.timezone), names: new Map(users.map((u) => [u.id, u.name])) };
  }

  // ---------- Self clock (not audited: the entry is the record) ----------

  private async status(tx: ScopedTx, actor: Actor): Promise<TimeclockStatus> {
    const shop = await tx.shop.findFirstOrThrow({ select: { timezone: true } });
    const now = new Date();
    const today = localDateOf(now, shop.timezone);
    const since = startOfLocalDay(addDays(mondayOf(today), -7), shop.timezone);
    const rows = await tx.timeEntry.findMany({
      where: { userId: actor.userId, OR: [{ clockInAt: { gte: since } }, { clockOutAt: null }] },
      orderBy: { clockInAt: 'desc' },
    });
    const ctx = await this.context(tx, rows.map((r) => r.editedByUserId), now);
    const entries = rows.map((r) => toTimeEntryDto(r, ctx));
    const open = entries.find((e) => e.clockOutAt === null) ?? null;
    return {
      serverNow: now.toISOString(),
      openEntry: open,
      todayMinutes: entries.filter((e) => e.localDate === today).reduce((sum, e) => sum + e.durationMinutes, 0),
      recentEntries: entries.filter((e) => Date.parse(e.clockInAt) >= since.getTime()),
    };
  }

  async me(actor: Actor): Promise<TimeclockStatus> {
    return this.db(actor).tx((tx) => this.status(tx, actor));
  }

  async clockIn(actor: Actor): Promise<TimeclockStatus> {
    try {
      return await this.db(actor).tx(async (tx) => {
        const open = await tx.timeEntry.findFirst({ where: { userId: actor.userId, clockOutAt: null }, select: { id: true } });
        if (open) throw apiError('ALREADY_CLOCKED_IN');
        await tx.timeEntry.create({
          data: { shopId: actor.shopId, userId: actor.userId, clockInAt: new Date(), source: 'SELF', createdByUserId: actor.userId },
        });
        return this.status(tx, actor);
      });
    } catch (err) {
      // Two tabs at once: the one-open-entry partial unique index decides.
      if (isUniqueViolation(err)) throw apiError('ALREADY_CLOCKED_IN');
      throw err;
    }
  }

  async clockOut(actor: Actor): Promise<TimeclockStatus> {
    return this.db(actor).tx(async (tx) => {
      const closed = await tx.timeEntry.updateMany({
        where: { userId: actor.userId, clockOutAt: null },
        data: { clockOutAt: new Date() },
      });
      if (closed.count === 0) throw apiError('NOT_CLOCKED_IN');
      return this.status(tx, actor);
    });
  }

  // ---------- Timesheets ----------

  private async loadTimesheet(tx: ScopedTx, q: TimesheetQuery) {
    const shop = await tx.shop.findFirstOrThrow({ select: { name: true, timezone: true } });
    const { start, end } = localRange(q.from, q.to, shop.timezone);
    // An entry belongs to the shop-local day it started on.
    const rows = await tx.timeEntry.findMany({
      where: { clockInAt: { gte: start, lt: end }, ...(q.userId ? { userId: q.userId } : {}) },
      orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const members = await tx.membership.findMany({
      where: { userId: { in: userIds } },
      include: { user: { select: { name: true, email: true } } },
    });
    const ctx = await this.context(tx, rows.map((r) => r.editedByUserId));
    const entries = rows.map((r) => ({ row: r, dto: toTimeEntryDto(r, ctx) }));
    return { shop, ctx, entries, members };
  }

  async timesheet(actor: Actor, q: TimesheetQuery): Promise<TimesheetResponse> {
    return this.db(actor).tx(async (tx) => {
      const { shop, ctx, entries, members } = await this.loadTimesheet(tx, q);
      const needsReview = (e: TimeEntry) => e.flaggedLong || e.stillOpen;
      const shown = q.needsReview ? entries.filter((e) => needsReview(e.dto)) : entries;

      const staff: TimesheetStaff[] = [];
      for (const m of members) {
        const mine = shown.filter((e) => e.row.userId === m.userId).map((e) => e.dto);
        if (!mine.length) continue;
        const byDay = new Map<string, TimeEntry[]>();
        for (const e of mine) byDay.set(e.localDate, [...(byDay.get(e.localDate) ?? []), e]);
        const days = [...byDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, list]) => ({ date, entries: list, totalMinutes: list.reduce((s, e) => s + e.durationMinutes, 0) }));
        staff.push({
          userId: m.userId,
          name: m.user.name,
          email: m.user.email,
          role: m.role,
          status: m.status === 'ACTIVE' ? 'ACTIVE' : 'DEACTIVATED',
          totalMinutes: days.reduce((s, d) => s + d.totalMinutes, 0),
          days,
        });
      }
      staff.sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
      return {
        from: q.from,
        to: q.to,
        timezone: shop.timezone,
        serverNow: ctx.now.toISOString(),
        staff,
        needsReviewCount: entries.filter((e) => needsReview(e.dto)).length,
      };
    });
  }

  /** CSV (UTF-8 with BOM, CRLF), one row per entry, cells escaped with `csvCell`. Audits `timesheet.exported`. */
  async exportCsv(actor: Actor, q: TimesheetQuery): Promise<{ filename: string; body: string }> {
    return this.db(actor).tx(async (tx) => {
      const { shop, ctx, entries, members } = await this.loadTimesheet(tx, q);
      const byUser = new Map(members.map((m) => [m.userId, m]));
      const shown = (q.needsReview ? entries.filter((e) => e.dto.flaggedLong || e.dto.stillOpen) : entries)
        .filter((e) => byUser.has(e.row.userId))
        .sort((a, b) => {
          const ma = byUser.get(a.row.userId)!;
          const mb = byUser.get(b.row.userId)!;
          return ma.user.name.localeCompare(mb.user.name) || a.row.clockInAt.getTime() - b.row.clockInAt.getTime();
        });
      const lines = [TIMESHEET_CSV_COLUMNS.map(csvCell).join(',')];
      for (const { row, dto } of shown) {
        const m = byUser.get(row.userId)!;
        const flags = [dto.flaggedLong && 'Long shift', dto.stillOpen && 'Still open', dto.closedReason === 'DEACTIVATED' && 'Closed on deactivation']
          .filter(Boolean)
          .join('; ');
        lines.push(
          [
            csvCell(m.user.name),
            csvCell(m.user.email),
            csvCell(ROLE_LABELS[m.role]),
            csvCell(dto.localDate),
            csvCell(localTimeOf(row.clockInAt, ctx.timeZone)),
            csvCell(row.clockOutAt ? localTimeOf(row.clockOutAt, ctx.timeZone) : ''),
            csvCell(decimalHours(dto.durationMinutes)),
            csvCell(dto.durationMinutes),
            csvCell(flags),
            csvCell(dto.edited ? 'Yes' : 'No'),
            csvCell(dto.edited?.reason ?? ''),
          ].join(','),
        );
      }
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'timesheet.exported',
        entityId: actor.shopId,
        after: { from: q.from, to: q.to, userId: q.userId ?? null, needsReview: q.needsReview, rows: shown.length },
      });
      return { filename: timesheetCsvFilename(shop.name, q.from, q.to), body: `\uFEFF${lines.join('\r\n')}\r\n` };
    });
  }

  // ---------- Corrections (timesheet.edit + canEditTimeEntry, D5) ----------

  /** The entry owner's membership (any status) and the D5 rule. 404 when the user is not in this shop. */
  private async assertCanEdit(tx: ScopedTx, actor: Actor, userId: string): Promise<void> {
    const m = await tx.membership.findFirst({ where: { userId }, select: { role: true } });
    if (!m) throw notFound();
    if (!canEditTimeEntry(actor.role, m.role, userId === actor.userId)) throw forbidden(API_ERROR_MESSAGES.FORBIDDEN);
  }

  /** Not in the future, ≤ 24h, out after in, no overlap with the same person's other entries. */
  private async assertValidTimes(tx: ScopedTx, userId: string, clockInAt: Date, clockOutAt: Date | null, exceptId?: string) {
    const now = Date.now();
    const issues: ApiIssue[] = [];
    if (clockInAt.getTime() > now) issues.push({ path: ['clockInAt'], message: "Clock-in can't be in the future" });
    if (clockOutAt) {
      const minutes = (clockOutAt.getTime() - clockInAt.getTime()) / 60_000;
      if (clockOutAt.getTime() > now) issues.push({ path: ['clockOutAt'], message: "Clock-out can't be in the future" });
      else if (minutes <= 0) issues.push({ path: ['clockOutAt'], message: 'Clock-out must be after clock-in' });
      else if (minutes > MAX_ENTRY_MINUTES) issues.push({ path: ['clockOutAt'], message: 'An entry can be at most 24 hours' });
    }
    if (issues.length) throw validationFailed(issues);

    const where: Prisma.TimeEntryWhereInput = {
      userId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      ...(clockOutAt ? { clockInAt: { lt: clockOutAt } } : {}),
      OR: [{ clockOutAt: null }, { clockOutAt: { gt: clockInAt } }],
    };
    if (await tx.timeEntry.findFirst({ where, select: { id: true } })) throw apiError('TIME_ENTRY_OVERLAP');
  }

  private async entryDto(tx: ScopedTx, row: TimeEntryRow): Promise<TimeEntry> {
    return toTimeEntryDto(row, await this.context(tx, [row.editedByUserId]));
  }

  async createEntry(actor: Actor, input: CreateTimeEntryInput): Promise<TimeEntry> {
    try {
      return await this.db(actor).tx(async (tx) => {
        await lockShop(tx, actor.shopId);
        await this.assertCanEdit(tx, actor, input.userId);
        const clockInAt = new Date(input.clockInAt);
        const clockOutAt = new Date(input.clockOutAt);
        await this.assertValidTimes(tx, input.userId, clockInAt, clockOutAt);
        const now = new Date();
        const row = await tx.timeEntry.create({
          data: {
            shopId: actor.shopId,
            userId: input.userId,
            clockInAt,
            clockOutAt,
            source: 'MANUAL',
            createdByUserId: actor.userId,
            editedAt: now,
            editedByUserId: actor.userId,
            editReason: input.reason,
          },
        });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'time_entry.created',
          entityId: row.id,
          after: { ...entrySnapshot(row), reason: input.reason },
        });
        return this.entryDto(tx, row);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw apiError('TIME_ENTRY_OVERLAP');
      throw err;
    }
  }

  async updateEntry(actor: Actor, id: string, input: UpdateTimeEntryInput): Promise<TimeEntry> {
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const entry = await tx.timeEntry.findFirst({ where: { id } });
      if (!entry) throw notFound();
      await this.assertCanEdit(tx, actor, entry.userId);
      const clockInAt = input.clockInAt ? new Date(input.clockInAt) : entry.clockInAt;
      const clockOutAt = input.clockOutAt ? new Date(input.clockOutAt) : entry.clockOutAt;
      await this.assertValidTimes(tx, entry.userId, clockInAt, clockOutAt, entry.id);
      const row = await tx.timeEntry.update({
        where: { id },
        data: { clockInAt, clockOutAt, editedAt: new Date(), editedByUserId: actor.userId, editReason: input.reason },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'time_entry.updated',
        entityId: id,
        before: { userId: entry.userId, clockInAt: iso(entry.clockInAt), clockOutAt: iso(entry.clockOutAt) },
        after: { userId: entry.userId, clockInAt: iso(clockInAt), clockOutAt: iso(clockOutAt), reason: input.reason },
      });
      return this.entryDto(tx, row);
    });
  }

  async deleteEntry(actor: Actor, id: string, reason: string): Promise<void> {
    await this.db(actor).tx(async (tx) => {
      const entry = await tx.timeEntry.findFirst({ where: { id } });
      if (!entry) throw notFound();
      await this.assertCanEdit(tx, actor, entry.userId);
      await tx.timeEntry.delete({ where: { id } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'time_entry.deleted',
        entityId: id,
        before: { ...entrySnapshot(entry), editReason: entry.editReason, reason },
      });
    });
  }
}
