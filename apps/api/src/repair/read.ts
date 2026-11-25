/**
 * Read-side helpers shared by the Sprint 2 services: shop context, user/status references, and the contract DTOs
 * for customers, devices and tickets. Everything runs inside the caller's `tenantDb(...).tx` (RLS applies).
 * Passcode columns are never selected here (only `passcodeKeyVersion`, to know one is on file).
 */
import {
  type BusinessHoursWeek,
  type ChecklistItemKey,
  type ChecklistResult,
  completeChecklist,
  type CountryCode,
  type CurrencyCode,
  type CustomerDetail,
  currentConsent,
  type Device as DeviceDto,
  type StatusRef,
  type TicketDetail,
  type TicketLink,
  type TicketListItem,
  type TicketStatus as TicketStatusDto,
  formatTicketNumber,
  isOverdue,
  REOPEN_WINDOW_DAYS,
  type StatusCategory,
  type StatusColour,
  type UserRef,
  type AccessoryCode,
  type IssueCode,
  type CancelReason,
  type DeviceType,
} from '@repairos/contracts';
import type { Prisma, ScopedTx, TicketStatus as StatusRow } from '@repairos/db';
import { notFound } from '../common/errors';
import { toWeek } from '../shop-settings/shop-settings.service';
import { lockCustomers } from './locks';

export { lockCustomers };

export interface ShopInfo {
  id: string;
  name: string;
  country: CountryCode;
  currency: CurrencyCode;
  locale: string;
  timezone: string;
  pricesIncludeTax: boolean;
  hours: BusinessHoursWeek;
  prefix: string;
  turnaroundDays: number;
  deletePasscodeOnClose: boolean;
}

interface ShopInfoRow {
  id: string;
  name: string;
  country: CountryCode;
  currency: CurrencyCode;
  locale: string;
  timezone: string;
  pricesIncludeTax: boolean;
  numberPrefix: string | null;
  defaultTurnaroundDays: number | null;
  deletePasscodeOnClose: boolean | null;
  hours: { weekday: number; isOpen: boolean; opensAt: string | null; closesAt: string | null }[];
}

/** The transaction's shop with its hours and ticket settings, in one round trip (every Sprint 2 request needs it). */
export async function loadShopInfo(tx: ScopedTx): Promise<ShopInfo> {
  const [shop] = await tx.$queryRaw<ShopInfoRow[]>`
    SELECT s."id", s."name", s."country"::text AS "country", s."currency"::text AS "currency", s."locale", s."timezone",
           s."pricesIncludeTax", st."numberPrefix", st."defaultTurnaroundDays", st."deletePasscodeOnClose",
           (SELECT coalesce(json_agg(json_build_object('weekday', h."weekday", 'isOpen', h."isOpen", 'opensAt', h."opensAt",
                                                       'closesAt', h."closesAt") ORDER BY h."weekday"), '[]'::json)
              FROM "business_hours" h WHERE h."shopId" = s."id") AS "hours"
    FROM "shops" s LEFT JOIN "shop_ticket_settings" st ON st."shopId" = s."id"
    WHERE s."id" = app_current_shop_id()`;
  if (!shop) throw notFound();
  return {
    id: shop.id,
    name: shop.name,
    country: shop.country,
    currency: shop.currency,
    locale: shop.locale,
    timezone: shop.timezone,
    pricesIncludeTax: shop.pricesIncludeTax,
    hours: toWeek(shop.hours as Parameters<typeof toWeek>[0]),
    prefix: shop.numberPrefix ?? 'T-',
    turnaroundDays: shop.defaultTurnaroundDays ?? 2,
    deletePasscodeOnClose: shop.deletePasscodeOnClose ?? true,
  };
}

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ---------- Users ----------

/** userId → UserRef (name + whether still an ACTIVE member of this shop). Unknown ids → "Former member". */
export async function userRefs(tx: ScopedTx, ids: Iterable<string | null | undefined>): Promise<Map<string, UserRef>> {
  const unique = [...new Set([...ids].filter((x): x is string => !!x))];
  const out = new Map<string, UserRef>();
  if (unique.length === 0) return out;
  const members = await tx.membership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, status: true, user: { select: { name: true } } },
  });
  for (const m of members) out.set(m.userId, { userId: m.userId, name: m.user.name, active: m.status === 'ACTIVE' });
  for (const id of unique) if (!out.has(id)) out.set(id, { userId: id, name: 'Former member', active: false });
  return out;
}

export const nameRef = (u: UserRef | undefined | null) => (u ? { userId: u.userId, name: u.name } : null);

// ---------- Statuses ----------

export type StatusMap = Map<string, StatusRow>;

export async function statusMap(tx: ScopedTx): Promise<StatusMap> {
  const rows = await tx.ticketStatus.findMany({ orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  return new Map(rows.map((r) => [r.id, r]));
}

export function toStatusRef(s: StatusRow): StatusRef {
  return {
    id: s.id,
    name: s.name,
    category: s.category as StatusCategory,
    colour: s.colour as StatusColour,
    systemRole: s.systemRole,
  };
}

export function statusRefOf(statuses: StatusMap, id: string): StatusRef {
  const s = statuses.get(id);
  if (!s) throw new Error(`Unknown status ${id}`);
  return toStatusRef(s);
}

export function toTicketStatusDto(s: StatusRow, ticketCount: number): TicketStatusDto {
  return {
    ...toStatusRef(s),
    position: s.position,
    isHidden: s.isHidden,
    notifyCustomer: s.notifyCustomer,
    requiresNote: s.requiresNote,
    ticketCount,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function ticketLink(prefix: string, t: { id: string; number: number }): TicketLink {
  return { id: t.id, number: t.number, numberLabel: formatTicketNumber(prefix, t.number) };
}

// ---------- Devices ----------

/** Device columns every read uses (never the ciphertext/IV/tag). */
export const DEVICE_SELECT = {
  id: true,
  customerId: true,
  type: true,
  brand: true,
  model: true,
  colour: true,
  imei: true,
  serial: true,
  notes: true,
  lockType: true,
  passcodeKeyVersion: true,
  passcodeSetAt: true,
  passcodeViewCount: true,
  passcodeLastViewedAt: true,
  passcodeLastViewedByUserId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DeviceSelect;
export type DeviceRow = Prisma.DeviceGetPayload<{ select: typeof DEVICE_SELECT }>;

/** Device rows → contract `Device` (ticket counts, open ticket, last ticket, last viewer resolved in batch). */
export async function deviceDtos(tx: ScopedTx, rows: DeviceRow[], prefix: string): Promise<DeviceDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [stats, open, viewers] = await Promise.all([
    tx.ticket.groupBy({ by: ['deviceId'], where: { deviceId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true } }),
    tx.ticket.findMany({
      where: { deviceId: { in: ids }, statusCategory: { not: 'CLOSED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, deviceId: true },
    }),
    userRefs(tx, rows.map((r) => r.passcodeLastViewedByUserId)),
  ]);
  const statBy = new Map(stats.map((s) => [s.deviceId, s]));
  const openBy = new Map<string, { id: string; number: number }>();
  for (const t of open) if (!openBy.has(t.deviceId)) openBy.set(t.deviceId, t);
  return rows.map((r) => {
    const st = statBy.get(r.id);
    const openTicket = openBy.get(r.id);
    return {
      id: r.id,
      customerId: r.customerId,
      type: r.type,
      brand: r.brand,
      model: r.model,
      colour: r.colour,
      imei: r.imei,
      serial: r.serial,
      notes: r.notes,
      lockType: r.lockType,
      passcodeOnFile: r.passcodeKeyVersion !== null,
      passcodeSetAt: r.passcodeKeyVersion !== null ? isoOrNull(r.passcodeSetAt) : null,
      passcodeViewCount: r.passcodeViewCount,
      passcodeLastViewedAt: isoOrNull(r.passcodeLastViewedAt),
      passcodeLastViewedBy: nameRef(viewers.get(r.passcodeLastViewedByUserId ?? '')),
      ticketCount: st?._count._all ?? 0,
      openTicket: openTicket ? ticketLink(prefix, openTicket) : null,
      lastTicketAt: isoOrNull(st?._max.createdAt),
      archivedAt: isoOrNull(r.archivedAt),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  });
}

export async function deviceDto(tx: ScopedTx, id: string, prefix: string): Promise<DeviceDto> {
  const row = await tx.device.findFirst({ where: { id }, select: DEVICE_SELECT });
  if (!row) throw notFound();
  return (await deviceDtos(tx, [row], prefix))[0]!;
}

// ---------- Customers ----------

export const PHONE_ORDER = [{ position: 'asc' }, { id: 'asc' }] satisfies Prisma.CustomerPhoneOrderByWithRelationInput[];

export function toPhoneDto(p: { id: string; e164: string; label: string; isPrimary: boolean; position: number }) {
  return { id: p.id, e164: p.e164, label: p.label as 'MOBILE', isPrimary: p.isPrimary, position: p.position };
}

/** primary phone (E.164) per customer id. */
export async function primaryPhones(tx: ScopedTx, customerIds: string[]): Promise<Map<string, string>> {
  if (customerIds.length === 0) return new Map();
  const rows = await tx.customerPhone.findMany({ where: { customerId: { in: customerIds }, isPrimary: true }, select: { customerId: true, e164: true } });
  return new Map(rows.map((r) => [r.customerId, r.e164]));
}

/** GET /api/customers/:id shape. Erased (or missing) → 404. */
export async function customerDetail(tx: ScopedTx, id: string): Promise<CustomerDetail> {
  const c = await tx.customer.findFirst({ where: { id, erasedAt: null } });
  if (!c) throw notFound();
  const [phones, events, ticketCount, deviceCount] = await Promise.all([
    tx.customerPhone.findMany({ where: { customerId: id }, orderBy: PHONE_ORDER }),
    tx.customerConsentEvent.findMany({ where: { customerId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    tx.ticket.count({ where: { customerId: id } }),
    tx.device.count({ where: { customerId: id, archivedAt: null } }),
  ]);
  const users = await userRefs(tx, [c.createdByUserId, ...events.map((e) => e.recordedByUserId)]);
  const consent = currentConsent(
    events.map((e) => ({
      channel: e.channel,
      state: e.state,
      source: e.source,
      createdAt: iso(e.createdAt),
      recordedBy: nameRef(users.get(e.recordedByUserId ?? '')),
    })),
  );
  const primary = phones.find((p) => p.isPrimary);
  return {
    id: c.id,
    kind: c.kind,
    displayName: c.displayName,
    businessContactName: c.businessContactName,
    primaryPhone: primary?.e164 ?? null,
    email: c.email,
    tags: c.tags,
    openTicketCount: c.openTicketCount,
    lastVisitAt: isoOrNull(c.lastVisitAt),
    createdAt: iso(c.createdAt),
    archivedAt: isoOrNull(c.archivedAt),
    firstName: c.firstName,
    lastName: c.lastName,
    businessName: c.businessName,
    phones: phones.map(toPhoneDto),
    whatsappPhoneId: phones.find((p) => p.isWhatsapp)?.id ?? null,
    addressLine1: c.addressLine1,
    addressLine2: c.addressLine2,
    city: c.city,
    region: c.region,
    postcode: c.postcode,
    notes: c.notes,
    preferredChannel: c.preferredChannel ?? 'SMS',
    serviceOptOutSms: c.serviceOptOutSms,
    serviceOptOutEmail: c.serviceOptOutEmail,
    serviceOptOutWhatsapp: c.serviceOptOutWhatsapp,
    consent,
    ticketCount,
    deviceCount,
    version: c.version,
    createdBy: nameRef(users.get(c.createdByUserId ?? '')),
    updatedAt: iso(c.updatedAt),
  };
}

/**
 * Keeps `customers.openTicketCount` and `lastVisitAt` equal to the tickets (non-closed count, latest createdAt).
 * Called in the same transaction as every ticket write that can change them. Does not bump `version`
 * (that is for edits of the customer record itself).
 *
 * M1: the customer rows are locked first (callers normally hold them already: lock order in ./locks), in a separate statement, so the recount (a new statement, i.e. a new
 * READ COMMITTED snapshot) sees the ticket changes of any transaction that held the lock before: two tickets of one
 * customer closing at the same time can no longer both count the other as still open.
 */
export async function refreshCustomerCounters(tx: ScopedTx, customerIds: Iterable<string>): Promise<void> {
  const unique = [...new Set(customerIds)].sort();
  await lockCustomers(tx, unique);
  for (const id of unique) {
    await tx.$executeRaw`
      UPDATE "customers" c SET
        "openTicketCount" = (SELECT count(*)::int FROM "tickets" t WHERE t."shopId" = c."shopId" AND t."customerId" = c."id" AND t."statusCategory" <> 'CLOSED'),
        "lastVisitAt" = (SELECT max(t."createdAt") FROM "tickets" t WHERE t."shopId" = c."shopId" AND t."customerId" = c."id")
      WHERE c."id" = ${id} AND c."shopId" = app_current_shop_id()`;
  }
}

// ---------- Tickets ----------

export const REOPEN_WINDOW_MS = REOPEN_WINDOW_DAYS * 86_400_000;

/** Full ticket detail (also the response of every ticket mutation). Missing → 404. */
export async function ticketDetail(tx: ScopedTx, id: string, shop: ShopInfo, now = new Date()): Promise<TicketDetail> {
  const t = await tx.ticket.findFirst({ where: { id } });
  if (!t) throw notFound();
  const [statuses, customer, phones, deviceRow, issues, checklist, accessories, warrantyOf, warrantyTickets, previousTicketCount] =
    await Promise.all([
      statusMap(tx),
      tx.customer.findFirst({ where: { id: t.customerId } }),
      tx.customerPhone.findMany({ where: { customerId: t.customerId }, orderBy: PHONE_ORDER }),
      tx.device.findFirst({ where: { id: t.deviceId }, select: DEVICE_SELECT }),
      tx.ticketIssue.findMany({ where: { ticketId: id }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
      tx.ticketChecklistItem.findMany({ where: { ticketId: id } }),
      tx.ticketAccessory.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } }),
      t.warrantyOfTicketId ? tx.ticket.findFirst({ where: { id: t.warrantyOfTicketId }, select: { id: true, number: true } }) : null,
      tx.ticket.findMany({ where: { warrantyOfTicketId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, number: true } }),
      tx.ticket.count({ where: { deviceId: t.deviceId, id: { not: id }, createdAt: { lt: t.createdAt } } }),
    ]);
  if (!customer || !deviceRow) throw notFound();
  const [device] = await deviceDtos(tx, [deviceRow], shop.prefix);
  const users = await userRefs(tx, [t.assigneeUserId, t.createdByUserId]);
  const erased = customer.erasedAt !== null;
  const results = Object.fromEntries(checklist.map((c) => [c.itemKey, c.result])) as Partial<Record<ChecklistItemKey, ChecklistResult>>;
  const accessoryOrder = (code: string) => ['SIM_CARD', 'SIM_TRAY', 'MEMORY_CARD', 'CASE', 'CHARGER', 'CABLE', 'STYLUS', 'BOX', 'OTHER'].indexOf(code);
  const closed = t.statusCategory === 'CLOSED';
  return {
    id: t.id,
    number: t.number,
    numberLabel: formatTicketNumber(shop.prefix, t.number),
    status: statusRefOf(statuses, t.statusId),
    statusChangedAt: iso(t.statusChangedAt),
    statusBeforeClose: closed && t.statusIdBeforeClose ? statusRefOf(statuses, t.statusIdBeforeClose) : null,
    priority: t.priority,
    customer: {
      id: customer.id,
      kind: customer.kind,
      displayName: customer.displayName,
      phones: erased ? [] : phones.map(toPhoneDto),
      whatsappPhoneId: erased ? null : (phones.find((p) => p.isWhatsapp)?.id ?? null),
      email: erased ? null : customer.email,
      preferredChannel: erased ? null : customer.preferredChannel,
      notes: erased ? null : customer.notes,
      archived: customer.archivedAt !== null,
      erased,
    },
    device: { ...device!, previousTicketCount },
    assignee: t.assigneeUserId ? (users.get(t.assigneeUserId) ?? null) : null,
    issues: issues.map((i) => ({ code: (i.code as IssueCode | null) ?? null, label: i.label })),
    description: t.description,
    checklist: completeChecklist(deviceRow.type as DeviceType, results) as Record<ChecklistItemKey, ChecklistResult>,
    conditionNotes: t.conditionNotes,
    accessories: accessories.map((a) => a.code as AccessoryCode).sort((a, b) => accessoryOrder(a) - accessoryOrder(b)),
    accessoriesOther: t.accessoriesOther,
    estimate: t.estimateMinor === null ? null : { amountMinor: t.estimateMinor, currency: t.currency },
    estimateIncludesTax: shop.pricesIncludeTax,
    dueAt: iso(t.dueAt),
    dueHasTime: t.dueHasTime,
    isOverdue: isOverdue({ statusCategory: t.statusCategory as StatusCategory, dueAt: t.dueAt }, now),
    warrantyOf: warrantyOf ? ticketLink(shop.prefix, warrantyOf) : null,
    warrantyTickets: warrantyTickets.map((w) => ticketLink(shop.prefix, w)),
    closedAt: isoOrNull(t.closedAt),
    cancelReason: closed ? ((t.cancelReason as CancelReason | null) ?? null) : null,
    cancelNote: closed ? t.cancelNote : null,
    reopenCount: t.reopenCount,
    reopenableUntil: closed && t.closedAt ? new Date(t.closedAt.getTime() + REOPEN_WINDOW_MS).toISOString() : null,
    version: t.version,
    createdBy: nameRef(users.get(t.createdByUserId ?? '')),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

/** Ticket ids → list items, in the given order. */
export async function ticketListItems(tx: ScopedTx, ids: string[], shop: ShopInfo, now = new Date()): Promise<TicketListItem[]> {
  if (ids.length === 0) return [];
  const tickets = await tx.ticket.findMany({ where: { id: { in: ids } } });
  const customerIds = [...new Set(tickets.map((t) => t.customerId))];
  const [statuses, customers, phones, devices, issues, users] = await Promise.all([
    statusMap(tx),
    tx.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, displayName: true, erasedAt: true } }),
    primaryPhones(tx, customerIds),
    tx.device.findMany({ where: { id: { in: [...new Set(tickets.map((t) => t.deviceId))] } }, select: { id: true, type: true, brand: true, model: true } }),
    tx.ticketIssue.findMany({ where: { ticketId: { in: ids } }, orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { ticketId: true, label: true } }),
    userRefs(tx, tickets.map((t) => t.assigneeUserId)),
  ]);
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const customerBy = new Map(customers.map((c) => [c.id, c]));
  const deviceBy = new Map(devices.map((d) => [d.id, d]));
  const issuesBy = new Map<string, string[]>();
  for (const i of issues) issuesBy.set(i.ticketId, [...(issuesBy.get(i.ticketId) ?? []), i.label]);
  return ids
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => {
      const c = customerBy.get(t.customerId)!;
      const d = deviceBy.get(t.deviceId)!;
      const erased = c.erasedAt !== null;
      return {
        id: t.id,
        number: t.number,
        numberLabel: formatTicketNumber(shop.prefix, t.number),
        isWarranty: t.warrantyOfTicketId !== null,
        customer: { id: c.id, displayName: c.displayName, primaryPhone: erased ? null : (phones.get(c.id) ?? null), erased },
        device: { id: d.id, type: d.type, brand: d.brand, model: d.model },
        issues: issuesBy.get(t.id) ?? [],
        description: t.description,
        status: statusRefOf(statuses, t.statusId),
        assignee: t.assigneeUserId ? (users.get(t.assigneeUserId) ?? null) : null,
        priority: t.priority,
        dueAt: iso(t.dueAt),
        dueHasTime: t.dueHasTime,
        isOverdue: isOverdue({ statusCategory: t.statusCategory as StatusCategory, dueAt: t.dueAt }, now),
        createdAt: iso(t.createdAt),
        updatedAt: iso(t.updatedAt),
        closedAt: isoOrNull(t.closedAt),
      };
    });
}
