import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  auditActionsInGroup,
  type AuditEntityType,
  type AuditEventDetail,
  type AuditEventListQuery,
  type AuditEventListResponse,
  type AuditEventSummary,
  deviceLabel,
  formatTicketNumber,
} from '@repairos/contracts';
import type { AuditLog, Prisma, ScopedTx } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { notFound, validationFailed } from '../common/errors';
import { localRange } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';

type Row = AuditLog & { actor: { id: string; name: string } | null };

export function encodeCursor(row: Pick<AuditLog, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

const asRecord = (v: Prisma.JsonValue | null): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Read-only audit log viewer (story §6). There is no write API; the DB role cannot UPDATE/DELETE audit_logs. */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  async list(actor: Actor, q: AuditEventListQuery): Promise<AuditEventListResponse> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) throw validationFailed([{ path: ['cursor'], message: 'Invalid cursor' }]);

    return this.db(actor).tx(async (tx) => {
      const shop = await tx.shop.findFirstOrThrow({ select: { timezone: true } });
      const { start, end } = localRange(q.from, q.to, shop.timezone);
      let actions: AuditAction[] = [...AUDIT_ACTIONS];
      if (q.actionGroup) actions = auditActionsInGroup(q.actionGroup);
      if (q.action) actions = actions.filter((a) => a === q.action);

      const where: Prisma.AuditLogWhereInput = {
        createdAt: { gte: start, lt: end },
        action: { in: actions },
        ...(q.userId ? { actorUserId: q.userId } : {}),
        ...(cursor
          ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
          : {}),
      };
      const rows: Row[] = await tx.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: { actor: { select: { id: true, name: true } } },
      });
      const page = rows.slice(0, q.limit);
      const labels = await this.entityLabels(tx, page);
      return {
        items: page.map((r) => this.summary(r, labels)),
        nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
      };
    });
  }

  async detail(actor: Actor, id: string): Promise<AuditEventDetail> {
    return this.db(actor).tx(async (tx) => {
      const row: Row | null = await tx.auditLog.findFirst({ where: { id }, include: { actor: { select: { id: true, name: true } } } });
      if (!row || !(AUDIT_ACTIONS as readonly string[]).includes(row.action)) throw notFound();
      const labels = await this.entityLabels(tx, [row]);
      return { ...this.summary(row, labels), before: asRecord(row.before), after: asRecord(row.after) };
    });
  }

  private summary(r: Row, labels: Map<string, string>): AuditEventSummary {
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action as AuditAction,
      actor: r.actor ? { userId: r.actor.id, name: r.actor.name } : null,
      entityType: r.entityType as AuditEntityType,
      entityId: r.entityId,
      entityLabel: labels.get(r.id) ?? null,
    };
  }

  /** Event id → readable entity label ("Sam Lee", "VAT", "sam@x.com", shop name). */
  private async entityLabels(tx: ScopedTx, rows: Row[]): Promise<Map<string, string>> {
    const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))];
    const entryUserId = (r: Row) => {
      const v = asRecord(r.after)?.userId ?? asRecord(r.before)?.userId;
      return typeof v === 'string' ? v : null;
    };
    const entryUsers = [...new Set(rows.filter((r) => r.entityType === 'TimeEntry').map(entryUserId).filter((x): x is string => !!x))];

    const [members, rates, invites, users, shop, customers, devices, tickets, statuses, settings] = await Promise.all([
      tx.membership.findMany({ where: { id: { in: ids('Membership') } }, select: { id: true, user: { select: { name: true } } } }),
      tx.taxRate.findMany({ where: { id: { in: ids('TaxRate') } }, select: { id: true, name: true } }),
      tx.invitation.findMany({ where: { id: { in: ids('Invitation') } }, select: { id: true, email: true } }),
      entryUsers.length ? tx.user.findMany({ where: { id: { in: entryUsers } }, select: { id: true, name: true } }) : [],
      tx.shop.findFirst({ select: { name: true } }),
      // Resolved now, so an erased customer reads "Erased customer" in every old row (A12).
      tx.customer.findMany({ where: { id: { in: ids('Customer') } }, select: { id: true, displayName: true } }),
      tx.device.findMany({ where: { id: { in: ids('Device') } }, select: { id: true, brand: true, model: true } }),
      tx.ticket.findMany({ where: { id: { in: ids('Ticket') } }, select: { id: true, number: true } }),
      tx.ticketStatus.findMany({ where: { id: { in: ids('TicketStatus') } }, select: { id: true, name: true } }),
      ids('Ticket').length ? tx.shopTicketSettings.findFirst({ select: { numberPrefix: true } }) : null,
    ]);
    const byId = new Map<string, string>([
      ...members.map((m) => [m.id, m.user.name] as const),
      ...rates.map((t) => [t.id, t.name] as const),
      ...invites.map((i) => [i.id, i.email] as const),
      ...customers.map((c) => [c.id, c.displayName] as const),
      ...devices.map((d) => [d.id, deviceLabel(d)] as const),
      ...tickets.map((t) => [t.id, formatTicketNumber(settings?.numberPrefix ?? 'T-', t.number)] as const),
      ...statuses.map((s) => [s.id, s.name] as const),
    ]);
    const userNames = new Map(users.map((u) => [u.id, u.name]));

    const out = new Map<string, string>();
    for (const r of rows) {
      let label: string | undefined;
      if (r.entityType === 'Shop') label = shop?.name;
      else if (r.entityType === 'TimeEntry') label = userNames.get(entryUserId(r) ?? '');
      else label = byId.get(r.entityId);
      if (label) out.set(r.id, label);
    }
    return out;
  }
}
