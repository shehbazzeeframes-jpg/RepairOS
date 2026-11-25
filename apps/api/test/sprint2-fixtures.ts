/**
 * Sprint 2 data fixtures, written through the tenant-scoped client as the app role (so RLS applies to the writes).
 * Until the Sprint 2 endpoints exist, tests build customers/devices/tickets with these.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient, ScopedTx, TenantDb } from '@repairos/db';
import { nextTicketNumber, tenantDb } from '@repairos/db';

export interface RepairFixture {
  customerId: string;
  phoneId: string;
  deviceId: string;
  ticketId: string;
  ticketNumber: number;
  noteId: string;
  statuses: Record<string, { id: string; category: string }>;
}

export async function statusesOf(tx: ScopedTx): Promise<Record<string, { id: string; category: string }>> {
  const rows = await tx.ticketStatus.findMany({ orderBy: { position: 'asc' } });
  return Object.fromEntries(rows.map((r) => [r.name, { id: r.id, category: r.category }]));
}

export interface CustomerSpec {
  firstName?: string;
  lastName?: string | null;
  businessName?: string | null;
  email?: string | null;
  phone?: string;
  imei?: string | null;
  serial?: string | null;
  addressLine1?: string | null;
  archived?: boolean;
}

/** Creates a customer (+ primary phone, a consent event, a device) in the transaction's shop. */
export async function createCustomer(tx: ScopedTx, shopId: string, userId: string, spec: CustomerSpec = {}) {
  const firstName = spec.firstName ?? 'Test';
  const lastName = spec.lastName === undefined ? 'Customer' : spec.lastName;
  const customer = await tx.customer.create({
    data: {
      shopId,
      kind: spec.businessName ? 'BUSINESS' : 'PERSON',
      firstName: spec.businessName ? null : firstName,
      lastName: spec.businessName ? null : lastName,
      businessName: spec.businessName ?? null,
      displayName: spec.businessName ?? [firstName, lastName].filter(Boolean).join(' '),
      email: spec.email ?? null,
      addressLine1: spec.addressLine1 ?? null,
      preferredChannel: 'SMS',
      createdByUserId: userId,
      archivedAt: spec.archived ? new Date() : null,
    },
  });
  const e164 = spec.phone ?? `+1212555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
  const phone = await tx.customerPhone.create({
    data: { shopId, customerId: customer.id, e164, digits: e164.slice(1), isPrimary: true, isWhatsapp: true },
  });
  await tx.customerConsentEvent.create({
    data: { shopId, customerId: customer.id, channel: 'SMS', state: 'GRANTED', source: 'IN_STORE_SIGNED', recordedByUserId: userId },
  });
  const device = await tx.device.create({
    data: {
      shopId,
      customerId: customer.id,
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 13',
      colour: 'Blue',
      imei: spec.imei ?? null,
      serial: spec.serial ?? null,
      createdByUserId: userId,
    },
  });
  return { customerId: customer.id, phoneId: phone.id, deviceId: device.id };
}

/** Creates a ticket (gapless number) with one issue, checklist item, accessory, note and two timeline events. */
export async function createTicket(
  tx: ScopedTx,
  shopId: string,
  userId: string,
  ref: { customerId: string; deviceId: string },
  opts: { status?: string; assigneeUserId?: string | null } = {},
) {
  const statuses = await statusesOf(tx);
  const status = statuses[opts.status ?? 'Received']!;
  const closed = status.category === 'CLOSED';
  const number = await nextTicketNumber(tx, shopId);
  const ticket = await tx.ticket.create({
    data: {
      shopId,
      number,
      statusId: status.id,
      statusCategory: status.category,
      customerId: ref.customerId,
      deviceId: ref.deviceId,
      assigneeUserId: opts.assigneeUserId ?? null,
      currency: 'USD',
      estimateMinor: 12900,
      dueAt: new Date(Date.now() + 2 * 86_400_000),
      closedAt: closed ? new Date() : null,
      createdByUserId: userId,
    },
  });
  await tx.ticketIssue.create({ data: { shopId, ticketId: ticket.id, code: 'SCREEN_CRACKED', label: 'Screen cracked' } });
  await tx.ticketChecklistItem.create({ data: { shopId, ticketId: ticket.id, itemKey: 'POWERS_ON', result: 'PASS' } });
  await tx.ticketAccessory.create({ data: { shopId, ticketId: ticket.id, code: 'CASE' } });
  const note = await tx.ticketNote.create({ data: { shopId, ticketId: ticket.id, authorUserId: userId, body: 'Checked in.' } });
  await tx.ticketEvent.create({
    data: { shopId, ticketId: ticket.id, actorUserId: userId, type: 'created', data: { statusId: status.id, warrantyOfTicketId: null } },
  });
  await tx.ticketEvent.create({ data: { shopId, ticketId: ticket.id, actorUserId: userId, type: 'note_added', noteId: note.id } });
  return { ticketId: ticket.id, ticketNumber: number, noteId: note.id };
}

/** One customer with a device and a ticket (with every child row) in a shop. */
export async function createRepair(appDb: PrismaClient, shopId: string, userId: string, spec: CustomerSpec = {}): Promise<RepairFixture> {
  const db: TenantDb = tenantDb(appDb, { shopId, userId });
  return db.tx(async (tx) => {
    const c = await createCustomer(tx, shopId, userId, spec);
    const t = await createTicket(tx, shopId, userId, c, { assigneeUserId: userId });
    await tx.ticketIdempotencyKey.create({ data: { shopId, userId, key: randomUUID(), ticketId: t.ticketId } });
    return { ...c, ...t, statuses: await statusesOf(tx) };
  });
}
