import { Inject, Injectable } from '@nestjs/common';
import {
  type CheckInContext,
  checkStatusCreate,
  checkStatusUpdate,
  computeDefaultDueAt,
  type CreateTicketStatusInput,
  isValidNextNumber,
  type ReorderTicketStatusesInput,
  type StatusCategory,
  type TicketSettings,
  type TicketStatus,
  type TicketStatusListResponse,
  type UpdateTicketSettingsInput,
  type UpdateTicketStatusInput,
} from '@repairos/contracts';
import type { Prisma, ScopedTx } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { changedFields, isUniqueViolation, lockShop, writeAudit } from '../common/audit';
import { apiError, notFound, validationFailed } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { loadShopInfo, toTicketStatusDto } from '../repair/read';

const STATUS_AUDIT_FIELDS = ['name', 'category', 'colour', 'notifyCustomer', 'isHidden', 'requiresNote'] as const;

/** Settings → Ticket statuses (§3) and Settings → Tickets (§4), plus the check-in context. */
@Injectable()
export class TicketConfigService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  private async statuses(tx: ScopedTx): Promise<TicketStatus[]> {
    const [rows, counts] = await Promise.all([
      tx.ticketStatus.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
      tx.ticket.groupBy({ by: ['statusId'], _count: { _all: true } }),
    ]);
    const countBy = new Map(counts.map((c) => [c.statusId, c._count._all]));
    return rows.map((r) => toTicketStatusDto(r, countBy.get(r.id) ?? 0));
  }

  async listStatuses(actor: Actor): Promise<TicketStatusListResponse> {
    return this.db(actor).tx(async (tx) => ({ items: await this.statuses(tx) }));
  }

  async createStatus(actor: Actor, input: CreateTicketStatusInput): Promise<TicketStatus> {
    try {
      return await this.db(actor).tx(async (tx) => {
        await lockShop(tx, actor.shopId);
        const existing = await this.statuses(tx);
        const rule = checkStatusCreate(existing, input);
        if (!rule.ok) throw apiError(rule.code);
        const row = await tx.ticketStatus.create({
          data: {
            shopId: actor.shopId,
            name: input.name,
            category: input.category,
            colour: input.colour,
            notifyCustomer: input.notifyCustomer ?? false,
            requiresNote: input.requiresNote ?? false,
            position: existing.reduce((m, s) => Math.max(m, s.position + 1), 0),
          },
        });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'ticket_status.created',
          entityId: row.id,
          after: { name: row.name, category: row.category, colour: row.colour, notifyCustomer: row.notifyCustomer, requiresNote: row.requiresNote, position: row.position },
        });
        return toTicketStatusDto(row, 0);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw apiError('STATUS_NAME_TAKEN');
      throw err;
    }
  }

  /** A category change re-categorises the status's tickets in the same statement (FK ON UPDATE CASCADE). */
  async updateStatus(actor: Actor, id: string, input: UpdateTicketStatusInput): Promise<TicketStatus> {
    try {
      return await this.db(actor).tx(async (tx) => {
        await lockShop(tx, actor.shopId);
        const existing = await this.statuses(tx);
        const target = existing.find((s) => s.id === id);
        if (!target) throw notFound();
        const rule = checkStatusUpdate(existing, id, input);
        if (!rule.ok) throw apiError(rule.code, rule.vars);
        const diff = changedFields(target as unknown as Record<string, unknown>, Object.fromEntries(STATUS_AUDIT_FIELDS.map((f) => [f, input[f]])));
        if (!diff) return target;
        await tx.ticketStatus.update({ where: { id }, data: diff.after });
        await writeAudit(tx, { shopId: actor.shopId, actorUserId: actor.userId, action: 'ticket_status.updated', entityId: id, ...diff });
        return (await this.statuses(tx)).find((s) => s.id === id)!;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw apiError('STATUS_NAME_TAKEN');
      throw err;
    }
  }

  async reorder(actor: Actor, input: ReorderTicketStatusesInput): Promise<TicketStatusListResponse> {
    return this.db(actor).tx(async (tx) => {
      await lockShop(tx, actor.shopId);
      const existing = await this.statuses(tx);
      const ids = new Set(existing.map((s) => s.id));
      if (input.ids.length !== ids.size || input.ids.some((x) => !ids.has(x))) {
        throw validationFailed([{ path: ['ids'], message: 'List every status exactly once' }]);
      }
      const before = existing.map((s) => s.id);
      if (before.join() !== input.ids.join()) {
        for (const [position, sid] of input.ids.entries()) await tx.ticketStatus.update({ where: { id: sid }, data: { position } });
        await writeAudit(tx, {
          shopId: actor.shopId,
          actorUserId: actor.userId,
          action: 'ticket_status.reordered',
          entityId: actor.shopId,
          before: { order: before },
          after: { order: input.ids },
        });
      }
      return { items: await this.statuses(tx) };
    });
  }

  // ---------- Settings → Tickets ----------

  private async settings(tx: ScopedTx): Promise<TicketSettings> {
    const s = await tx.shopTicketSettings.findFirst();
    if (!s) throw notFound();
    const max = await tx.ticket.aggregate({ _max: { number: true } });
    return {
      defaultTurnaroundDays: s.defaultTurnaroundDays,
      numberPrefix: s.numberPrefix,
      nextNumber: s.nextNumber,
      highestUsedNumber: max._max.number ?? null,
      deletePasscodeOnClose: s.deletePasscodeOnClose,
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  async getSettings(actor: Actor): Promise<TicketSettings> {
    return this.db(actor).tx((tx) => this.settings(tx));
  }

  async updateSettings(actor: Actor, input: UpdateTicketSettingsInput): Promise<TicketSettings> {
    return this.db(actor).tx(async (tx) => {
      // Same row lock as nextTicketNumber(), so a check-in cannot take a number between the check and the update.
      await tx.$queryRaw`SELECT "id" FROM "shop_ticket_settings" WHERE "shopId" = ${actor.shopId} FOR UPDATE`;
      const current = await this.settings(tx);
      if (input.nextNumber !== undefined && !isValidNextNumber(input.nextNumber, current.highestUsedNumber)) {
        throw apiError('TICKET_NUMBER_TOO_LOW', { highest: String(current.highestUsedNumber ?? 0) });
      }
      const diff = changedFields(current as unknown as Record<string, unknown>, {
        defaultTurnaroundDays: input.defaultTurnaroundDays,
        numberPrefix: input.numberPrefix,
        nextNumber: input.nextNumber,
        deletePasscodeOnClose: input.deletePasscodeOnClose,
      });
      if (!diff) return current;
      await tx.shopTicketSettings.updateMany({ data: diff.after as Prisma.ShopTicketSettingsUpdateManyMutationInput });
      await writeAudit(tx, { shopId: actor.shopId, actorUserId: actor.userId, action: 'shop.ticket_settings_updated', entityId: actor.shopId, ...diff });
      return this.settings(tx);
    });
  }

  /** Everything check-in needs without settings.view (front desk). */
  async checkInContext(actor: Actor, now = new Date()): Promise<CheckInContext> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const due = computeDefaultDueAt(now, shop.turnaroundDays, shop.hours, shop.timezone);
      return {
        serverNow: now.toISOString(),
        country: shop.country,
        currency: shop.currency,
        locale: shop.locale,
        timezone: shop.timezone,
        pricesIncludeTax: shop.pricesIncludeTax,
        hours: shop.hours,
        defaultTurnaroundDays: shop.turnaroundDays,
        numberPrefix: shop.prefix,
        defaultDue: { dueAt: due.dueAt, date: due.date, dueHasTime: false },
      };
    });
  }
}

export type { StatusCategory };
