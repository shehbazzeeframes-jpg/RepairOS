import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import {
  deviceLabel,
  formatTicketNumber,
  GlobalSearchQuery,
  type GlobalSearchResponse,
  hasPermission,
  normalizePhone,
  parseTicketNumberQuery,
} from '@repairos/contracts';
import { searchCustomers, searchDevices, searchTickets } from '@repairos/db';
import { type Actor, CurrentActor, ShopScoped } from '../auth/auth-context';
import { ZodQuery } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { loadShopInfo, primaryPhones, statusMap, statusRefOf } from '../repair/read';

/**
 * Global search / command palette (story §7). Each group is filled only with its permission. Fuzzy matching runs in
 * the SECURITY DEFINER search functions (indexes usable under RLS, PERF.md).
 */
@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async search(actor: Actor, q: GlobalSearchQuery): Promise<GlobalSearchResponse> {
    const canTickets = hasPermission(actor.role, 'tickets.view');
    const canCustomers = hasPermission(actor.role, 'customers.view');
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId }).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const ticketNumber = parseTicketNumberQuery(q.q, shop.prefix);
      const phoneE164 = normalizePhone(q.q, shop.country);

      const [ticketHits, customerHits, deviceHits] = await Promise.all([
        canTickets ? searchTickets(tx, { shopId: actor.shopId, q: q.q, ticketNumber, phoneE164, limit: q.limit }) : [],
        canCustomers ? searchCustomers(tx, { q: q.q, phoneE164, includeArchived: q.includeArchived, limit: q.limit, matchDevices: false }) : [],
        canCustomers ? searchDevices(tx, q.q, q.limit) : [],
      ]);

      // Tickets
      const tickets = ticketHits.length
        ? await tx.ticket.findMany({
            where: { id: { in: ticketHits.map((h) => h.id) } },
            select: { id: true, number: true, statusId: true, customer: { select: { displayName: true } }, device: { select: { brand: true, model: true } } },
          })
        : [];
      const statuses = await statusMap(tx);
      const ticketBy = new Map(tickets.map((t) => [t.id, t]));

      // Customers
      const customers = customerHits.length
        ? await tx.customer.findMany({
            where: { id: { in: customerHits.map((h) => h.id) }, erasedAt: null },
            select: { id: true, kind: true, displayName: true, email: true, archivedAt: true },
          })
        : [];
      const phones = await primaryPhones(
        tx,
        customers.map((c) => c.id),
      );
      const customerBy = new Map(customers.map((c) => [c.id, c]));

      // Devices (+ owner, latest ticket); erased customers' devices have no IMEI/serial left to match.
      const devices = deviceHits.length
        ? await tx.device.findMany({
            where: { id: { in: deviceHits.map((h) => h.id) }, customer: { erasedAt: null } },
            select: { id: true, type: true, brand: true, model: true, imei: true, serial: true, customer: { select: { id: true, displayName: true } } },
          })
        : [];
      const latest = devices.length
        ? await tx.ticket.findMany({
            where: { deviceId: { in: devices.map((d) => d.id) } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, number: true, deviceId: true },
          })
        : [];
      const latestBy = new Map<string, { id: string; number: number }>();
      for (const t of latest) if (!latestBy.has(t.deviceId)) latestBy.set(t.deviceId, t);
      const deviceBy = new Map(devices.map((d) => [d.id, d]));

      const response: GlobalSearchResponse = {
        tickets: ticketHits
          .map((h) => ticketBy.get(h.id))
          .filter((t): t is NonNullable<typeof t> => !!t)
          .map((t) => ({
            id: t.id,
            numberLabel: formatTicketNumber(shop.prefix, t.number),
            customerDisplayName: t.customer.displayName,
            deviceLabel: deviceLabel(t.device),
            status: statusRefOf(statuses, t.statusId),
          })),
        customers: customerHits
          .map((h) => customerBy.get(h.id))
          .filter((c): c is NonNullable<typeof c> => !!c)
          .map((c) => ({
            id: c.id,
            kind: c.kind,
            displayName: c.displayName,
            primaryPhone: phones.get(c.id) ?? null,
            email: c.email,
            archivedAt: c.archivedAt?.toISOString() ?? null,
          })),
        devices: deviceHits
          .map((h) => deviceBy.get(h.id))
          .filter((d): d is NonNullable<typeof d> => !!d)
          .map((d) => {
            const t = latestBy.get(d.id);
            return {
              id: d.id,
              type: d.type,
              label: deviceLabel(d),
              imei: d.imei,
              serial: d.serial,
              customer: { id: d.customer.id, displayName: d.customer.displayName },
              latestTicket: t ? { id: t.id, numberLabel: formatTicketNumber(shop.prefix, t.number) } : null,
            };
          }),
        exactMatch: null,
      };

      // Enter jumps straight there for an exact ticket number, full IMEI or full serial (barcode scanners).
      const exactTicket = ticketNumber !== null ? tickets.find((t) => t.number === ticketNumber) : undefined;
      const normalized = q.q.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const exactDevice = devices.find((d) => d.imei === normalized || d.serial === normalized);
      if (exactTicket) response.exactMatch = { kind: 'ticket', ticketId: exactTicket.id };
      else if (exactDevice) {
        response.exactMatch = { kind: 'device', deviceId: exactDevice.id, customerId: exactDevice.customer.id, ticketId: latestBy.get(exactDevice.id)?.id ?? null };
      }
      return response;
    });
  }
}

@Controller('search')
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  /** Any member with an active shop; groups are filtered by permission in the service. */
  @ShopScoped()
  @Get()
  get(@CurrentActor() actor: Actor, @ZodQuery(GlobalSearchQuery) q: GlobalSearchQuery) {
    return this.search.search(actor, q);
  }
}
