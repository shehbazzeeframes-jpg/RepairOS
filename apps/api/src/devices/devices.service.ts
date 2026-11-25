import { Inject, Injectable } from '@nestjs/common';
import {
  type CreateDeviceInput,
  type Device,
  type DeviceListResponse,
  type DeviceLookupQuery,
  type DeviceLookupResponse,
  IMEI_DEVICE_TYPES,
  type ModelSuggestionsQuery,
  type ModelSuggestionsResponse,
  type PasscodeInput,
  suggestModels,
  type UpdateDeviceInputParsed,
} from '@repairos/contracts';
import { createId } from '@paralleldrive/cuid2';
import type { ScopedTx } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { CONFIG, type AppConfig } from '../config';
import { apiError, notFound, validationFailed } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { auditPasscodeChange, isSecretLock, passcodeData } from '../repair/passcode';
import { lockCustomers, lockDevices } from '../repair/locks';
import { DEVICE_SELECT, deviceDto, deviceDtos, loadShopInfo, ticketLink } from '../repair/read';

/**
 * Creates a device for a customer (also used nested in check-in). A secret passcode is encrypted and audited
 * (`device.passcode_changed`, lock types only).
 */
export async function insertDevice(
  tx: ScopedTx,
  ctx: { shopId: string; userId: string; keyring: AppConfig['fieldEncryption'] },
  customerId: string,
  input: CreateDeviceInput,
): Promise<string> {
  const id = createId();
  const passcode = passcodeData(ctx.keyring, ctx.shopId, id, input.passcode ?? { lockType: 'NONE' });
  await tx.device.create({
    data: {
      id,
      shopId: ctx.shopId,
      customerId,
      type: input.type,
      brand: input.brand,
      model: input.model,
      colour: input.colour,
      imei: input.imei,
      serial: input.serial,
      notes: input.notes,
      createdByUserId: ctx.userId,
      ...passcode,
    },
  });
  if (isSecretLock(passcode.lockType)) {
    await auditPasscodeChange(tx, { shopId: ctx.shopId, actorUserId: ctx.userId, deviceId: id, before: null, after: passcode.lockType });
  }
  return id;
}

/** Sets/replaces/clears a device's passcode; audits when something changed. */
export async function setDevicePasscode(
  tx: ScopedTx,
  ctx: { shopId: string; userId: string; keyring: AppConfig['fieldEncryption'] },
  deviceId: string,
  current: { lockType: Device['lockType']; passcodeOnFile: boolean },
  input: PasscodeInput,
): Promise<void> {
  const data = passcodeData(ctx.keyring, ctx.shopId, deviceId, input);
  if (!isSecretLock(input.lockType) && input.lockType === current.lockType && !current.passcodeOnFile) return; // nothing to change
  await tx.device.update({ where: { id: deviceId }, data });
  await auditPasscodeChange(tx, { shopId: ctx.shopId, actorUserId: ctx.userId, deviceId, before: current.lockType, after: input.lockType });
}

/** Devices (story §2). */
@Injectable()
export class DevicesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  private ctx(actor: Actor) {
    return { shopId: actor.shopId, userId: actor.userId, keyring: this.config.fieldEncryption };
  }

  async listForCustomer(actor: Actor, customerId: string, archived: boolean): Promise<DeviceListResponse> {
    return this.db(actor).tx(async (tx) => {
      const c = await tx.customer.findFirst({ where: { id: customerId, erasedAt: null }, select: { id: true } });
      if (!c) throw notFound();
      const shop = await loadShopInfo(tx);
      const rows = await tx.device.findMany({
        where: { customerId, ...(archived ? {} : { archivedAt: null }) },
        select: DEVICE_SELECT,
      });
      const items = await deviceDtos(tx, rows, shop.prefix);
      items.sort(
        (a, b) =>
          (b.lastTicketAt ?? '').localeCompare(a.lastTicketAt ?? '') || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
      );
      return { items };
    });
  }

  async create(actor: Actor, customerId: string, input: CreateDeviceInput): Promise<Device> {
    return this.db(actor).tx(async (tx) => {
      await lockCustomers(tx, [customerId]);
      const c = await tx.customer.findFirst({ where: { id: customerId } });
      if (!c) throw notFound();
      if (c.erasedAt) throw apiError('CUSTOMER_ERASED');
      if (c.archivedAt) throw apiError('CUSTOMER_ARCHIVED');
      const id = await insertDevice(tx, this.ctx(actor), customerId, input);
      return deviceDto(tx, id, (await loadShopInfo(tx)).prefix);
    });
  }

  async update(actor: Actor, id: string, input: UpdateDeviceInputParsed): Promise<Device> {
    return this.db(actor).tx(async (tx) => {
      // L1: lock the owner first (as erase does), then read: a concurrent erase either commits before this read
      // (→ CUSTOMER_ERASED) or waits until this edit commits and then clears what it wrote.
      const owner = await tx.device.findFirst({ where: { id }, select: { customerId: true } });
      if (!owner) throw notFound();
      await lockCustomers(tx, [owner.customerId]);
      await lockDevices(tx, [id]); // lock order: customer → device
      const d = await tx.device.findFirst({ where: { id }, select: { ...DEVICE_SELECT, customer: { select: { erasedAt: true } } } });
      if (!d) throw notFound();
      if (d.customer.erasedAt) throw apiError('CUSTOMER_ERASED');
      const type = input.type ?? d.type;
      const imei = input.imei === undefined ? d.imei : input.imei;
      if (imei && !IMEI_DEVICE_TYPES.includes(type)) {
        throw validationFailed([{ path: ['imei'], message: 'IMEI is only recorded for phones, tablets and watches' }]);
      }
      await tx.device.update({
        where: { id },
        data: {
          type,
          brand: input.brand ?? d.brand,
          model: input.model ?? d.model,
          ...(input.colour !== undefined ? { colour: input.colour } : {}),
          imei,
          ...(input.serial !== undefined ? { serial: input.serial } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
      });
      if (input.passcode) {
        await setDevicePasscode(tx, this.ctx(actor), id, { lockType: d.lockType, passcodeOnFile: d.passcodeKeyVersion !== null }, input.passcode);
      }
      return deviceDto(tx, id, (await loadShopInfo(tx)).prefix);
    });
  }

  async archive(actor: Actor, id: string): Promise<Device> {
    return this.db(actor).tx(async (tx) => {
      // Same device lock as a check-in on this device, so the open-ticket count below cannot miss a new ticket.
      await lockDevices(tx, [id]);
      const d = await tx.device.findFirst({ where: { id }, select: { archivedAt: true } });
      if (!d) throw notFound();
      if (!d.archivedAt) {
        const open = await tx.ticket.count({ where: { deviceId: id, statusCategory: { not: 'CLOSED' } } });
        if (open > 0) throw apiError('DEVICE_HAS_OPEN_TICKETS');
        await tx.device.update({ where: { id }, data: { archivedAt: new Date() } });
      }
      return deviceDto(tx, id, (await loadShopInfo(tx)).prefix);
    });
  }

  async restore(actor: Actor, id: string): Promise<Device> {
    return this.db(actor).tx(async (tx) => {
      const d = await tx.device.findFirst({ where: { id }, select: { archivedAt: true } });
      if (!d) throw notFound();
      if (d.archivedAt) await tx.device.update({ where: { id }, data: { archivedAt: null } });
      return deviceDto(tx, id, (await loadShopInfo(tx)).prefix);
    });
  }

  async lookup(actor: Actor, q: DeviceLookupQuery): Promise<DeviceLookupResponse> {
    return this.db(actor).tx(async (tx) => {
      const shop = await loadShopInfo(tx);
      const rows = await tx.device.findMany({
        where: { ...(q.imei ? { imei: q.imei } : { serial: q.serial }), customer: { erasedAt: null } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: 10,
        select: { id: true, customerId: true, type: true, brand: true, model: true, customer: { select: { displayName: true, archivedAt: true } } },
      });
      const last = await tx.ticket.findMany({
        where: { deviceId: { in: rows.map((r) => r.id) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, number: true, deviceId: true },
      });
      const lastBy = new Map<string, { id: string; number: number }>();
      for (const t of last) if (!lastBy.has(t.deviceId)) lastBy.set(t.deviceId, t);
      return {
        matches: rows.map((r) => {
          const t = lastBy.get(r.id);
          return {
            deviceId: r.id,
            customerId: r.customerId,
            customerDisplayName: r.customer.displayName,
            customerArchived: r.customer.archivedAt !== null,
            sameCustomer: !!q.customerId && q.customerId === r.customerId,
            type: r.type,
            brand: r.brand,
            model: r.model,
            lastTicket: t ? ticketLink(shop.prefix, t) : null,
          };
        }),
      };
    });
  }

  /** R1/R2: catalogue + this shop's models, one-box (type/brand optional). */
  async modelSuggestions(actor: Actor, q: ModelSuggestionsQuery): Promise<ModelSuggestionsResponse> {
    return this.db(actor).tx(async (tx) => {
      const history = await tx.device.groupBy({
        by: ['type', 'brand', 'model'],
        where: { ...(q.type ? { type: q.type } : {}), ...(q.brand ? { brand: { equals: q.brand, mode: 'insensitive' } } : {}) },
        _count: { _all: true },
        orderBy: { _count: { id: 'desc' } },
        take: 500,
      });
      return {
        items: suggestModels({
          type: q.type,
          brand: q.brand,
          q: q.q,
          limit: q.limit,
          shopHistory: history.map((h) => ({ type: h.type, brand: h.brand, model: h.model, useCount: h._count._all })),
        }),
      };
    });
  }
}
