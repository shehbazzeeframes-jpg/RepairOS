import { Inject, Injectable } from '@nestjs/common';
import {
  type BusinessHoursWeek,
  canBeDefaultFor,
  type CreateTaxRateInput,
  DEFAULT_BUSINESS_HOURS,
  type ShopProfile,
  shopProfileSchema,
  type ShopSettingsResponse,
  type TaxRate,
  type TaxSettings,
  type UpdateBusinessHoursInput,
  type UpdateTaxRateInput,
  type UpdateTaxSettingsInput,
} from '@repairos/contracts';
import type { BusinessHours, ScopedTx, Shop as ShopRow, TaxRate as TaxRateRow } from '@repairos/db';
import type { Actor } from '../auth/auth-context';
import { changedFields, writeAudit } from '../common/audit';
import { apiError, notFound, validationFailed } from '../common/errors';
import { ZodValidationPipe } from '../common/zod';
import { PrismaService } from '../prisma/prisma.service';
import { toShopDto } from '../shops/shops.service';

export function toShopProfile(row: ShopRow): ShopProfile {
  return {
    ...toShopDto(row),
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postcode: row.postcode,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTaxRateDto(r: TaxRateRow): TaxRate {
  return {
    id: r.id,
    name: r.name,
    rateMilliPct: r.rateMilliPct,
    appliesTo: r.appliesTo,
    isDefaultGoods: r.isDefaultGoods,
    isDefaultServices: r.isDefaultServices,
    archivedAt: r.archivedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Rows → the 7-day week (missing days fall back to the D9 default). */
export function toWeek(rows: BusinessHours[]): BusinessHoursWeek {
  return DEFAULT_BUSINESS_HOURS.map((def) => {
    const r = rows.find((x) => x.weekday === def.weekday);
    if (!r) return def;
    return r.isOpen
      ? { weekday: r.weekday, isOpen: true, opensAt: r.opensAt, closesAt: r.closesAt }
      : { weekday: r.weekday, isOpen: false, opensAt: null, closesAt: null };
  });
}

const PROFILE_FIELDS = ['name', 'phone', 'addressLine1', 'addressLine2', 'city', 'region', 'postcode', 'timezone'] as const;

const sortRates = (a: TaxRateRow, b: TaxRateRow) =>
  Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

@Injectable()
export class ShopSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private db(actor: Actor) {
    return this.prisma.forShop({ shopId: actor.shopId, userId: actor.userId });
  }

  async getSettings(actor: Actor): Promise<ShopSettingsResponse> {
    return this.db(actor).tx(async (tx) => {
      const shop = await tx.shop.findFirst();
      if (!shop) throw notFound();
      const hours = await tx.businessHours.findMany({ orderBy: { weekday: 'asc' } });
      return { shop: toShopProfile(shop), hours: toWeek(hours) };
    });
  }

  // ---------- Profile ----------

  /** PATCH /api/shop: parsed with `shopProfileSchema(shop.country)`; audits changed fields only. */
  async updateProfile(actor: Actor, body: unknown): Promise<ShopProfile> {
    return this.db(actor).tx(async (tx) => {
      const shop = await tx.shop.findFirst();
      if (!shop) throw notFound();
      const input = new ZodValidationPipe(shopProfileSchema(shop.country)).transform(body ?? {});
      const patch: Partial<Record<(typeof PROFILE_FIELDS)[number], string | null>> = {};
      for (const f of PROFILE_FIELDS) if (input[f] !== undefined) patch[f] = input[f];
      const diff = changedFields(shop as unknown as Record<string, unknown>, patch);
      if (!diff) return toShopProfile(shop);
      const updated = await tx.shop.update({ where: { id: shop.id }, data: diff.after as Partial<ShopRow> });
      await writeAudit(tx, { shopId: shop.id, actorUserId: actor.userId, action: 'shop.updated', entityId: shop.id, ...diff });
      return toShopProfile(updated);
    });
  }

  async updateTaxSettings(actor: Actor, input: UpdateTaxSettingsInput): Promise<TaxSettings> {
    return this.db(actor).tx(async (tx) => {
      const shop = await tx.shop.findFirst();
      if (!shop) throw notFound();
      if (shop.pricesIncludeTax !== input.pricesIncludeTax) {
        await tx.shop.update({ where: { id: shop.id }, data: { pricesIncludeTax: input.pricesIncludeTax } });
        await writeAudit(tx, {
          shopId: shop.id,
          actorUserId: actor.userId,
          action: 'shop.tax_settings_updated',
          entityId: shop.id,
          before: { pricesIncludeTax: shop.pricesIncludeTax },
          after: { pricesIncludeTax: input.pricesIncludeTax },
        });
      }
      return { pricesIncludeTax: input.pricesIncludeTax };
    });
  }

  // ---------- Business hours ----------

  async updateHours(actor: Actor, input: UpdateBusinessHoursInput): Promise<{ days: BusinessHoursWeek }> {
    return this.db(actor).tx(async (tx) => {
      const before = toWeek(await tx.businessHours.findMany());
      const after = input.days;
      if (JSON.stringify(before) === JSON.stringify(after)) return { days: after };
      for (const d of after) {
        const data = { isOpen: d.isOpen, opensAt: d.opensAt, closesAt: d.closesAt };
        await tx.businessHours.upsert({
          where: { shopId_weekday: { shopId: actor.shopId, weekday: d.weekday } },
          update: data,
          create: { shopId: actor.shopId, weekday: d.weekday, ...data },
        });
      }
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'shop.hours_updated',
        entityId: actor.shopId,
        before: { days: before },
        after: { days: after },
      });
      return { days: after };
    });
  }

  // ---------- Tax rates ----------

  async listTaxRates(actor: Actor, includeArchived: boolean): Promise<{ items: TaxRate[] }> {
    const rows = await this.db(actor).client.taxRate.findMany({ where: includeArchived ? {} : { archivedAt: null } });
    return { items: rows.sort(sortRates).map(toTaxRateDto) };
  }

  private async assertNameFree(tx: ScopedTx, name: string, exceptId?: string): Promise<void> {
    const clash = await tx.taxRate.findFirst({
      where: { archivedAt: null, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) throw apiError('TAX_RATE_NAME_TAKEN');
  }

  /** Moves the goods/services default badge to `rate` (in the same transaction) and audits the move. */
  private async moveDefault(tx: ScopedTx, actor: Actor, rate: TaxRateRow, kind: 'goods' | 'services'): Promise<TaxRateRow> {
    const field = kind === 'goods' ? 'isDefaultGoods' : 'isDefaultServices';
    if (rate[field]) return rate;
    const previous = await tx.taxRate.findFirst({ where: { [field]: true }, select: { id: true, name: true } });
    if (previous) await tx.taxRate.update({ where: { id: previous.id }, data: { [field]: false } });
    const updated = await tx.taxRate.update({ where: { id: rate.id }, data: { [field]: true } });
    await writeAudit(tx, {
      shopId: actor.shopId,
      actorUserId: actor.userId,
      action: 'tax_rate.default_changed',
      entityId: rate.id,
      before: { [field]: false, previousDefaultId: previous?.id ?? null, previousDefaultName: previous?.name ?? null },
      after: { [field]: true, name: rate.name },
    });
    return updated;
  }

  async createTaxRate(actor: Actor, input: CreateTaxRateInput): Promise<TaxRate> {
    return this.db(actor).tx(async (tx) => {
      await this.assertNameFree(tx, input.name);
      let rate = await tx.taxRate.create({
        data: { shopId: actor.shopId, name: input.name, rateMilliPct: input.rateMilliPct, appliesTo: input.appliesTo },
      });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'tax_rate.created',
        entityId: rate.id,
        after: { name: rate.name, rateMilliPct: rate.rateMilliPct, appliesTo: rate.appliesTo },
      });
      if (input.isDefaultGoods) rate = await this.moveDefault(tx, actor, rate, 'goods');
      if (input.isDefaultServices) rate = await this.moveDefault(tx, actor, rate, 'services');
      return toTaxRateDto(rate);
    });
  }

  async updateTaxRate(actor: Actor, id: string, input: UpdateTaxRateInput): Promise<TaxRate> {
    return this.db(actor).tx(async (tx) => {
      let rate = await tx.taxRate.findFirst({ where: { id } });
      if (!rate) throw notFound();
      if (rate.archivedAt) throw apiError('TAX_RATE_ARCHIVED');
      const appliesTo = input.appliesTo ?? rate.appliesTo;
      const issues = [];
      if (input.isDefaultGoods && !canBeDefaultFor(appliesTo, 'goods')) {
        issues.push({ path: ['isDefaultGoods'], message: 'A services rate can’t be the goods default' });
      }
      if (input.isDefaultServices && !canBeDefaultFor(appliesTo, 'services')) {
        issues.push({ path: ['isDefaultServices'], message: 'A goods rate can’t be the services default' });
      }
      if (issues.length) throw validationFailed(issues);
      if (
        (rate.isDefaultGoods && !canBeDefaultFor(appliesTo, 'goods')) ||
        (rate.isDefaultServices && !canBeDefaultFor(appliesTo, 'services'))
      ) {
        throw apiError('TAX_RATE_IS_DEFAULT');
      }
      if (input.name !== undefined && input.name.toLowerCase() !== rate.name.toLowerCase()) await this.assertNameFree(tx, input.name, id);

      const diff = changedFields(
        { name: rate.name, rateMilliPct: rate.rateMilliPct, appliesTo: rate.appliesTo },
        { name: input.name, rateMilliPct: input.rateMilliPct, appliesTo: input.appliesTo },
      );
      if (diff) {
        rate = await tx.taxRate.update({ where: { id }, data: diff.after });
        await writeAudit(tx, { shopId: actor.shopId, actorUserId: actor.userId, action: 'tax_rate.updated', entityId: id, ...diff });
      }
      if (input.isDefaultGoods) rate = await this.moveDefault(tx, actor, rate, 'goods');
      if (input.isDefaultServices) rate = await this.moveDefault(tx, actor, rate, 'services');
      return toTaxRateDto(rate);
    });
  }

  async archiveTaxRate(actor: Actor, id: string): Promise<TaxRate> {
    return this.db(actor).tx(async (tx) => {
      const rate = await tx.taxRate.findFirst({ where: { id } });
      if (!rate) throw notFound();
      if (rate.archivedAt) return toTaxRateDto(rate);
      const active = await tx.taxRate.count({ where: { archivedAt: null } });
      if (active <= 1) throw apiError('LAST_TAX_RATE');
      if (rate.isDefaultGoods || rate.isDefaultServices) throw apiError('TAX_RATE_IS_DEFAULT');
      const archivedAt = new Date();
      const updated = await tx.taxRate.update({ where: { id }, data: { archivedAt } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'tax_rate.archived',
        entityId: id,
        before: { archivedAt: null, name: rate.name },
        after: { archivedAt: archivedAt.toISOString(), name: rate.name },
      });
      return toTaxRateDto(updated);
    });
  }

  async restoreTaxRate(actor: Actor, id: string): Promise<TaxRate> {
    return this.db(actor).tx(async (tx) => {
      const rate = await tx.taxRate.findFirst({ where: { id } });
      if (!rate) throw notFound();
      if (!rate.archivedAt) return toTaxRateDto(rate);
      await this.assertNameFree(tx, rate.name, id);
      const updated = await tx.taxRate.update({ where: { id }, data: { archivedAt: null } });
      await writeAudit(tx, {
        shopId: actor.shopId,
        actorUserId: actor.userId,
        action: 'tax_rate.restored',
        entityId: id,
        before: { archivedAt: rate.archivedAt.toISOString(), name: rate.name },
        after: { archivedAt: null, name: rate.name },
      });
      return toTaxRateDto(updated);
    });
  }
}
