import { Inject, Injectable } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { type CreateShopInput, MARKET_DEFAULTS, type Shop } from '@repairos/contracts';
import type { Shop as ShopRow } from '@repairos/db';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { AuthContext } from '../auth/auth-context';
import { validationFailed } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';

export function toShopDto(row: ShopRow): Shop {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    currency: row.currency,
    locale: row.locale,
    timezone: row.timezone,
    pricesIncludeTax: row.pricesIncludeTax,
    phone: row.phone,
    createdAt: row.createdAt.toISOString(),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Normalises to E.164 with the shop's country as the default region; null when empty. */
export function normalisePhone(raw: string | undefined, country: CreateShopInput['country']): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, country);
  if (!parsed || !parsed.isValid()) {
    throw validationFailed([{ path: ['phone'], message: 'Enter a valid phone number' }]);
  }
  return parsed.number;
}

@Injectable()
export class ShopsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Onboarding: creates the shop with market defaults, a "Main" location, the caller's OWNER
   * membership, default tax rates and an audit entry in one transaction, then makes it the
   * session's active shop.
   */
  async create(auth: AuthContext, input: CreateShopInput): Promise<Shop> {
    const market = MARKET_DEFAULTS[input.country];
    const timezone = input.timezone ?? market.timezone;
    if (!isValidTimeZone(timezone)) {
      throw validationFailed([{ path: ['timezone'], message: 'Unknown time zone' }]);
    }
    const phone = normalisePhone(input.phone, input.country);

    const shopId = createId();
    const userId = auth.user.id;
    const db = this.prisma.forShop({ shopId, userId });

    const shop = await db.tx(async (tx) => {
      const created = await tx.shop.create({
        data: {
          id: shopId,
          name: input.name,
          country: input.country,
          currency: market.currency,
          locale: market.locale,
          timezone,
          pricesIncludeTax: market.pricesIncludeTax,
          phone,
          addressLine1: input.addressLine1 || null,
          city: input.city || null,
          postcode: input.postcode || null,
        },
      });
      await tx.location.create({ data: { shopId, name: 'Main', isPrimary: true } });
      await tx.membership.create({ data: { shopId, userId, role: 'OWNER' } });
      await tx.taxRate.createMany({
        data: market.taxRates.map((t) => ({ shopId, name: t.name, rateBps: t.rateBps, appliesTo: t.appliesTo })),
      });
      const dto = toShopDto(created);
      await tx.auditLog.create({
        data: { shopId, actorUserId: userId, action: 'shop.created', entityType: 'Shop', entityId: shopId, after: dto },
      });
      return created;
    });

    await this.prisma.base.session.update({ where: { id: auth.sessionId }, data: { activeShopId: shop.id } });
    return toShopDto(shop);
  }
}
