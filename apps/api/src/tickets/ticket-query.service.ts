import { Inject, Injectable } from '@nestjs/common';
import {
  type AssigneesResponse,
  canEditNote,
  type CancelReason,
  type DashboardSummary,
  DASHBOARD_QUEUE_SIZE,
  DASHBOARD_UNASSIGNED_SIZE,
  LIST_TOTAL_CAP,
  localDateInZone,
  localDayRange,
  normalizePhone,
  parseTicketNumberQuery,
  type TicketCounts,
  type TicketListQuery,
  type TicketListResponse,
  type TicketNote,
  type TicketTimelineItem,
  TIMELINE_FILTER_TYPES,
  type TimelineQuery,
  type TimelineResponse,
  type UserRef,
} from '@repairos/contracts';
import { Prisma, type ScopedTx, ticketSearchSql, type TicketEventDataByType } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { decodeKeyset, encodeKeyset } from '../common/cursor';
import { notFound, validationFailed } from '../common/errors';
import { localRange } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';
import { loadShopInfo, type ShopInfo, statusMap, statusRefOf, ticketLink, ticketListItems, userRefs } from '../repair/read';

interface KeyRow {
  id: string;
  number: number;
  priority: string;
  dueAt: Date;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  closedFlag: boolean;
}

/** Same predicate as the counts query and contracts `ticketInView` (deactivated assignee counts as unassigned). */
const UNASSIGNED = Prisma.sql`(t."assigneeUserId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "memberships" m WHERE m."shopId" = t."shopId" AND m."userId" = t."assigneeUserId" AND m."status" = 'ACTIVE'))`;

type ListArgs = Omit<TicketListQuery, 'limit'> & { limit: number };

/** Ticket list, counts, dashboard, timeline and assignees (story §5.2, §5.3, §6). */
@Injectable()
export class TicketQueryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  async list(actor: Actor, q: TicketListQuery, now = new Date()): Promise<TicketListResponse> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const page = await this.listPage(tx, shop, actor, q, now, true);
      return { ...page, serverNow: now.toISOString() };
    });
  }

  /**
   * One page of a view + filters, keyset-paginated, with the total capped at LIST_TOTAL_CAP
   * (`SELECT count(*) FROM (... LIMIT cap+1)`, PERF.md finding 2). Search joins the SECURITY DEFINER search functions.
   */
  async listPage(tx: ScopedTx, shop: ShopInfo, actor: Actor, q: ListArgs, now: Date, withTotal: boolean) {
    const where: Prisma.Sql[] = [Prisma.sql`t."shopId" = ${actor.shopId}`];
    const NON_CLOSED = Prisma.sql`t."statusCategory" IN ('OPEN', 'WAITING', 'READY')`;
    const TRACKED = Prisma.sql`t."statusCategory" IN ('OPEN', 'WAITING')`;
    switch (q.view) {
      case 'open':
        where.push(NON_CLOSED);
        break;
      case 'mine':
        where.push(Prisma.sql`t."assigneeUserId" = ${actor.userId}`, NON_CLOSED);
        break;
      case 'unassigned':
        where.push(TRACKED, UNASSIGNED);
        break;
      case 'ready':
        where.push(Prisma.sql`t."statusCategory" = 'READY'`);
        break;
      case 'overdue':
        where.push(TRACKED, Prisma.sql`t."dueAt" < ${now}`);
        break;
      case 'closed':
        where.push(Prisma.sql`t."statusCategory" = 'CLOSED'`);
        break;
      case 'all':
        break;
    }
    if (q.status?.length) where.push(Prisma.sql`t."statusId" = ANY(${q.status}::text[])`);
    if (q.category?.length) where.push(Prisma.sql`t."statusCategory" = ANY(${q.category}::text[])`);
    if (q.assignee?.length) {
      const ids = q.assignee.filter((a) => a !== 'unassigned');
      const parts: Prisma.Sql[] = [];
      if (ids.length) parts.push(Prisma.sql`t."assigneeUserId" = ANY(${ids}::text[])`);
      if (q.assignee.includes('unassigned')) parts.push(UNASSIGNED);
      where.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`);
    }
    if (q.priority) where.push(Prisma.sql`t."priority" = ${q.priority}::"TicketPriority"`);
    if (q.createdFrom || q.createdTo) {
      const { start, end } = localRange(q.createdFrom ?? '2000-01-01', q.createdTo ?? '2999-12-31', shop.timezone);
      where.push(Prisma.sql`t."createdAt" >= ${start} AND t."createdAt" < ${end}`);
    }
    if (q.dueFrom || q.dueTo) {
      const { start, end } = localRange(q.dueFrom ?? '2000-01-01', q.dueTo ?? '2999-12-31', shop.timezone);
      where.push(Prisma.sql`t."dueAt" >= ${start} AND t."dueAt" < ${end}`);
    }
    if (q.deviceType?.length) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM "devices" d WHERE d."shopId" = t."shopId" AND d."id" = t."deviceId" AND d."type"::text = ANY(${q.deviceType}::text[]))`);
    }
    if (q.warranty === true) where.push(Prisma.sql`t."warrantyOfTicketId" IS NOT NULL`);
    if (q.warranty === false) where.push(Prisma.sql`t."warrantyOfTicketId" IS NULL`);
    if (q.customerId) where.push(Prisma.sql`t."customerId" = ${q.customerId}`);
    if (q.deviceId) where.push(Prisma.sql`t."deviceId" = ${q.deviceId}`);
    const join = q.q
      ? Prisma.sql`JOIN (${ticketSearchSql({
          shopId: actor.shopId,
          q: q.q,
          ticketNumber: parseTicketNumberQuery(q.q, shop.prefix),
          phoneE164: normalizePhone(q.q, shop.country),
        })}) h ON h."id" = t."id"`
      : Prisma.empty;
    const filter = Prisma.join(where, ' AND ');

    const sort = q.sort === 'default' ? (q.view === 'closed' ? 'closed' : 'default') : q.sort;
    let order: Prisma.Sql;
    let after: Prisma.Sql = Prisma.empty;
    let keyOf: (r: KeyRow) => (string | number | boolean | null)[];
    switch (sort) {
      case 'default': {
        order = Prisma.sql`t."priority" DESC, t."dueAt", t."number"`;
        const c = decodeKeyset(q.cursor, ['string', 'date', 'number']);
        if (c) {
          const [p, d, n] = c as [string, Date, number];
          if (p !== 'URGENT' && p !== 'NORMAL') throw validationFailed([{ path: ['cursor'], message: 'Invalid cursor' }]);
          after = Prisma.sql`AND (t."priority" < ${p}::"TicketPriority" OR (t."priority" = ${p}::"TicketPriority" AND (t."dueAt", t."number") > (${d}, ${n})))`;
        }
        keyOf = (r) => [r.priority, r.dueAt.toISOString(), r.number];
        break;
      }
      case 'closed': {
        // Same order as tickets_closed_idx (closedAt DESC, id) so the Closed view is an index scan, not a sort of
        // the whole history. Only the Closed view is guaranteed non-null; elsewhere open tickets (null) go last.
        order =
          q.view === 'closed' ? Prisma.sql`t."closedAt" DESC, t."id"` : Prisma.sql`t."closedAt" DESC NULLS LAST, t."id"`;
        const c = decodeKeyset(q.cursor, ['date?', 'string']);
        if (c) {
          const [at, id] = c as [Date | null, string];
          after = at
            ? Prisma.sql`AND (t."closedAt" < ${at} OR (t."closedAt" = ${at} AND t."id" > ${id}) OR t."closedAt" IS NULL)`
            : Prisma.sql`AND t."closedAt" IS NULL AND t."id" > ${id}`;
        }
        keyOf = (r) => [r.closedAt?.toISOString() ?? null, r.id];
        break;
      }
      case 'due': {
        order = Prisma.sql`t."dueAt", t."number"`;
        const c = decodeKeyset(q.cursor, ['date', 'number']);
        if (c) after = Prisma.sql`AND (t."dueAt", t."number") > (${c[0] as Date}, ${c[1] as number})`;
        keyOf = (r) => [r.dueAt.toISOString(), r.number];
        break;
      }
      case 'created':
      case 'updated': {
        const col = sort === 'created' ? Prisma.sql`t."createdAt"` : Prisma.sql`t."updatedAt"`;
        // (createdAt DESC, id) matches tickets_created_idx.
        order = Prisma.sql`${col} DESC, t."id"`;
        const c = decodeKeyset(q.cursor, ['date', 'string']);
        if (c) after = Prisma.sql`AND (${col} < ${c[0] as Date} OR (${col} = ${c[0] as Date} AND t."id" > ${c[1] as string}))`;
        keyOf = (r) => [(sort === 'created' ? r.createdAt : r.updatedAt).toISOString(), r.id];
        break;
      }
      case 'number': {
        order = Prisma.sql`t."number" DESC`;
        const c = decodeKeyset(q.cursor, ['number']);
        if (c) after = Prisma.sql`AND t."number" < ${c[0] as number}`;
        keyOf = (r) => [r.number];
        break;
      }
      case 'open_first': {
        order = Prisma.sql`(t."statusCategory" = 'CLOSED'), t."createdAt" DESC, t."id" DESC`;
        const c = decodeKeyset(q.cursor, ['boolean', 'date', 'string']);
        if (c) {
          const [f, at, id] = c as [boolean, Date, string];
          after = Prisma.sql`AND ((t."statusCategory" = 'CLOSED') > ${f} OR ((t."statusCategory" = 'CLOSED') = ${f} AND (t."createdAt", t."id") < (${at}, ${id})))`;
        }
        keyOf = (r) => [r.closedFlag, r.createdAt.toISOString(), r.id];
        break;
      }
    }

    const rows = await tx.$queryRaw<KeyRow[]>`
      SELECT t."id", t."number", t."priority"::text AS "priority", t."dueAt", t."closedAt", t."createdAt", t."updatedAt",
             (t."statusCategory" = 'CLOSED') AS "closedFlag"
      FROM "tickets" t ${join}
      WHERE ${filter} ${after}
      ORDER BY ${order}
      LIMIT ${q.limit + 1}`;
    let total = 0;
    if (withTotal) {
      const [count] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM (SELECT 1 FROM "tickets" t ${join} WHERE ${filter} LIMIT ${LIST_TOTAL_CAP + 1}) x`;
      total = count?.n ?? 0;
    }
    const pageRows = rows.slice(0, q.limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: await ticketListItems(
        tx,
        pageRows.map((r) => r.id),
        shop,
        now,
      ),
      nextCursor: rows.length > q.limit && last ? encodeKeyset(keyOf(last)) : null,
      total: Math.min(total, LIST_TOTAL_CAP),
      totalCapped: total > LIST_TOTAL_CAP,
    };
  }

  /** One grouped query over non-closed tickets (index-only on tickets_status_due_idx). */
  async countsIn(tx: ScopedTx, shop: ShopInfo, actor: Actor, now: Date): Promise<TicketCounts> {
    const { start, end } = localDayRange(localDateInZone(now, shop.timezone), shop.timezone);
    const [c] = await tx.$queryRaw<Omit<TicketCounts, 'serverNow'>[]>`
      SELECT count(*)::int AS "open",
             count(*) FILTER (WHERE t."assigneeUserId" = ${actor.userId})::int AS "mine",
             count(*) FILTER (WHERE t."statusCategory" IN ('OPEN', 'WAITING') AND ${UNASSIGNED})::int AS "unassigned",
             count(*) FILTER (WHERE t."statusCategory" = 'READY')::int AS "ready",
             count(*) FILTER (WHERE t."statusCategory" IN ('OPEN', 'WAITING') AND t."dueAt" < ${now})::int AS "overdue",
             count(*) FILTER (WHERE t."statusCategory" IN ('OPEN', 'WAITING') AND t."dueAt" >= ${start} AND t."dueAt" < ${end})::int AS "dueToday",
             count(*) FILTER (WHERE t."statusCategory" IN ('OPEN', 'WAITING'))::int AS "openAndWaiting"
      FROM "tickets" t
      WHERE t."shopId" = ${actor.shopId} AND t."statusCategory" IN ('OPEN', 'WAITING', 'READY')`;
    return { ...c!, serverNow: now.toISOString() };
  }

  async counts(actor: Actor, now = new Date()): Promise<TicketCounts> {
    return this.db(actor).tx(async (tx) => this.countsIn(tx, await loadShopInfo(tx), actor, now));
  }

  async dashboard(actor: Actor, now = new Date()): Promise<DashboardSummary> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const counts = await this.countsIn(tx, shop, actor, now);
      const base = { sort: 'default' as const, cursor: undefined };
      const mine = await this.listPage(tx, shop, actor, { ...base, view: 'mine', limit: DASHBOARD_QUEUE_SIZE }, now, false);
      const unassigned =
        mine.items.length === 0
          ? (await this.listPage(tx, shop, actor, { ...base, view: 'unassigned', limit: DASHBOARD_UNASSIGNED_SIZE }, now, false)).items
          : [];
      return { counts, myQueue: mine.items, myQueueTotal: counts.mine, unassigned };
    });
  }

  async assignees(actor: Actor): Promise<AssigneesResponse> {
    return this.db(actor).tx(async (tx) => {
      const members = await tx.membership.findMany({
        where: { status: 'ACTIVE' },
        select: { userId: true, role: true, user: { select: { name: true } } },
      });
      const items = members
        .map((m) => ({ userId: m.userId, name: m.user.name, role: m.role, isSelf: m.userId === actor.userId }))
        .sort((a, b) => Number(b.role === 'TECHNICIAN') - Number(a.role === 'TECHNICIAN') || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
      return { items };
    });
  }

  // ---------- Timeline ----------

  /** Newest `limit` items first page (returned oldest → newest); `olderCursor` pages back. */
  async timeline(actor: Actor, ticketId: string, q: TimelineQuery, now = new Date()): Promise<TimelineResponse> {
    const cursor = decodeKeyset(q.cursor, ['date', 'string']) as [Date, string] | null;
    return this.db(actor).tx(async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id: ticketId }, select: { id: true } });
      if (!ticket) throw notFound();
      const shop = await loadShopInfo(tx);
      const rows = await tx.ticketEvent.findMany({
        where: {
          ticketId,
          type: { in: [...TIMELINE_FILTER_TYPES[q.filter]] },
          ...(cursor ? { OR: [{ createdAt: { lt: cursor[0] } }, { createdAt: cursor[0], id: { lt: cursor[1] } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit).reverse();
      const items = await mapTimeline(tx, page, shop, actor.userId, now);
      const oldest = page[0];
      return { items, olderCursor: rows.length > q.limit && oldest ? encodeKeyset([oldest.createdAt.toISOString(), oldest.id]) : null };
    });
  }
}

type EventRow = { id: string; type: string; data: Prisma.JsonValue; noteId: string | null; actorUserId: string | null; createdAt: Date };

export function toNoteDto(
  n: { id: string; body: string; visibility: 'INTERNAL' | 'CUSTOMER'; authorUserId: string; createdAt: Date; editedAt: Date | null },
  author: UserRef,
  viewerId: string,
  now: Date,
): TicketNote {
  return {
    id: n.id,
    body: n.body,
    visibility: n.visibility,
    author,
    createdAt: n.createdAt.toISOString(),
    editedAt: n.editedAt?.toISOString() ?? null,
    canEdit: canEditNote(n, viewerId, now),
  };
}

/**
 * Stored events (ids only, `TicketEventDataByType`) → contract timeline items, resolving status names, people,
 * notes, ticket numbers, device labels (snapshotted) and customer names (current: "Erased customer" after erasure).
 */
export async function mapTimeline(tx: ScopedTx, rows: EventRow[], shop: ShopInfo, viewerId: string, now: Date): Promise<TicketTimelineItem[]> {
  const data = (r: EventRow) => (r.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const userIds = new Set<string>();
  const ticketIds = new Set<string>();
  const customerIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const r of rows) {
    if (r.actorUserId) userIds.add(r.actorUserId);
    if (r.noteId) noteIds.add(r.noteId);
    const d = data(r);
    for (const k of ['fromUserId', 'toUserId']) if (str(d[k])) userIds.add(str(d[k])!);
    for (const k of ['ticketId', 'warrantyOfTicketId']) if (str(d[k])) ticketIds.add(str(d[k])!);
    for (const k of ['fromCustomerId', 'toCustomerId']) if (str(d[k])) customerIds.add(str(d[k])!);
  }
  const [statuses, notes, tickets, customers] = await Promise.all([
    statusMap(tx),
    noteIds.size ? tx.ticketNote.findMany({ where: { id: { in: [...noteIds] } } }) : [],
    ticketIds.size ? tx.ticket.findMany({ where: { id: { in: [...ticketIds] } }, select: { id: true, number: true } }) : [],
    customerIds.size ? tx.customer.findMany({ where: { id: { in: [...customerIds] } }, select: { id: true, displayName: true } }) : [],
  ]);
  for (const n of notes) userIds.add(n.authorUserId);
  const users = await userRefs(tx, userIds);
  const noteBy = new Map(notes.map((n) => [n.id, n]));
  const ticketBy = new Map(tickets.map((t) => [t.id, t]));
  const customerBy = new Map(customers.map((c) => [c.id, c.displayName]));
  const status = (id: unknown) => statusRefOf(statuses, String(id));
  const link = (id: unknown) => {
    const t = ticketBy.get(String(id));
    return t ? ticketLink(shop.prefix, t) : null;
  };
  const user = (id: unknown) => (str(id) ? (users.get(str(id)!) ?? null) : null);

  const out: TicketTimelineItem[] = [];
  for (const r of rows) {
    const base = { id: r.id, createdAt: r.createdAt.toISOString(), actor: user(r.actorUserId) };
    const d = data(r);
    switch (r.type as keyof TicketEventDataByType) {
      case 'created':
        out.push({ ...base, type: 'created', data: { status: status(d.statusId), warrantyOf: d.warrantyOfTicketId ? link(d.warrantyOfTicketId) : null } });
        break;
      case 'status_changed':
        out.push({
          ...base,
          type: 'status_changed',
          data: { from: status(d.fromStatusId), to: status(d.toStatusId), notifyPending: d.notifyPending === true, noteId: r.noteId },
        });
        break;
      case 'assigned':
        out.push({ ...base, type: 'assigned', data: { from: user(d.fromUserId), to: user(d.toUserId) } });
        break;
      case 'fields_changed':
        out.push({ ...base, type: 'fields_changed', data: { changes: (d.changes as { field: string; before: unknown; after: unknown }[]) ?? [] } });
        break;
      case 'device_changed':
        out.push({ ...base, type: 'device_changed', data: d as TicketEventDataByType['device_changed'] });
        break;
      case 'customer_changed':
        out.push({
          ...base,
          type: 'customer_changed',
          data: {
            from: { customerId: String(d.fromCustomerId), displayName: customerBy.get(String(d.fromCustomerId)) ?? '' },
            to: { customerId: String(d.toCustomerId), displayName: customerBy.get(String(d.toCustomerId)) ?? '' },
          },
        });
        break;
      case 'note_added': {
        const n = r.noteId ? noteBy.get(r.noteId) : undefined;
        if (n) out.push({ ...base, type: 'note_added', data: { note: toNoteDto(n, users.get(n.authorUserId)!, viewerId, now) } });
        break;
      }
      case 'note_edited':
        out.push({ ...base, type: 'note_edited', data: { noteId: r.noteId ?? '' } });
        break;
      case 'cancelled':
        out.push({
          ...base,
          type: 'cancelled',
          data: { status: status(d.statusId), reason: d.reason as CancelReason, note: str(d.note), returnedConfirmed: d.returnedConfirmed === true },
        });
        break;
      case 'reopened':
        out.push({
          ...base,
          type: 'reopened',
          data: { from: status(d.fromStatusId), to: status(d.toStatusId), reason: String(d.reason ?? ''), passcodeWasDeleted: d.passcodeWasDeleted === true },
        });
        break;
      case 'warranty_linked': {
        const l = link(d.ticketId);
        if (l) out.push({ ...base, type: 'warranty_linked', data: { ticket: l, role: d.role === 'original' ? 'original' : 'warranty' } });
        break;
      }
      case 'passcode_deleted':
        out.push({ ...base, type: 'passcode_deleted', data: { reason: 'closed' } });
        break;
      default:
        out.push({ ...base, type: r.type as 'message_sent', data: d });
    }
  }
  return out;
}
