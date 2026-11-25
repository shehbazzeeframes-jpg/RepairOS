import { Inject, Injectable, Logger } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { type CreateShopInput, DEFAULT_BUSINESS_HOURS, MARKET_DEFAULTS, type Shop } from '@repairos/contracts';
import type { Shop as ShopRow } from '@repairos/db';
import type { AuthContext } from '../auth/auth-context';
import { writeAudit } from '../common/audit';
import { apiError, ApiException, validationFailed } from '../common/errors';
import { CONFIG, type AppConfig } from '../config';
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

/** Canonical IANA name (e.g. "europe/london" → "Europe/London"), or null when unknown. */
export function canonicalTimeZone(tz: string): string | null {
  // Offset zones ("+05:00") are valid for Intl but have no DST rules: require an IANA name.
  if (/^[+-]/.test(tz.trim())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * Sliding one-hour window of successful shop creations per user (§7 SC1.2). In-memory per process, acceptable
 * until the BACKLOG Redis-store item.
 */
export class HourlyLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number) {}

  isLimited(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    this.hits.set(key, recent);
    return recent.length >= this.max;
  }

  record(key: string, now = Date.now()): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
  }
}

@Injectable()
export class ShopsService {
  private readonly logger = new Logger('ShopsService');
  private readonly createLimiter: HourlyLimiter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.createLimiter = new HourlyLimiter(config.shopCreatePerHour);
  }

  /**
   * Onboarding: creates the shop with market defaults (tax rates with goods/services defaults, D9 business
   * hours), a "Main" location, the caller's OWNER membership and an audit entry in one transaction, then makes
   * it the session's active shop. §7: at most `shopOwnedLimit` owned shops and `shopCreatePerHour` per hour.
   */
  async create(auth: AuthContext, input: CreateShopInput): Promise<Shop> {
    const userId = auth.user.id;
    const memberships = await this.prisma.membershipsOf(userId);
    const owned = memberships.filter((m) => m.status === 'ACTIVE' && m.role === 'OWNER').length;
    if (owned >= this.config.shopOwnedLimit) {
      // shop.create_blocked is not audited (no shop exists): app log only.
      this.logger.warn(`shop.create_blocked user=${userId} owned=${owned} limit=${this.config.shopOwnedLimit}`);
      throw apiError('SHOP_LIMIT_REACHED');
    }
    if (this.createLimiter.isLimited(userId)) {
      this.logger.warn(`shop.create_blocked user=${userId} reason=rate_limited`);
      throw new ApiException(429, 'RATE_LIMITED', 'Too many shops created. Try again later.');
    }

    const market = MARKET_DEFAULTS[input.country];
    const timezone = canonicalTimeZone(input.timezone ?? market.timezone);
    if (!timezone) throw validationFailed([{ path: ['timezone'], message: 'Unknown time zone' }]);

    const shopId = createId();
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
          phone: input.phone ?? null,
          addressLine1: input.addressLine1 ?? null,
          addressLine2: input.addressLine2 ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postcode: input.postcode ?? null,
        },
      });
      await tx.location.create({ data: { shopId, name: 'Main', isPrimary: true } });
      await tx.membership.create({ data: { shopId, userId, role: 'OWNER' } });
      await tx.taxRate.createMany({
        data: market.taxRates.map((t) => ({
          shopId,
          name: t.name,
          rateMilliPct: t.rateMilliPct,
          appliesTo: t.appliesTo,
          isDefaultGoods: t.isDefaultGoods,
          isDefaultServices: t.isDefaultServices,
        })),
      });
      await tx.businessHours.createMany({
        data: DEFAULT_BUSINESS_HOURS.map((d) => ({ shopId, weekday: d.weekday, isOpen: d.isOpen, opensAt: d.opensAt, closesAt: d.closesAt })),
      });
      await writeAudit(tx, { shopId, actorUserId: userId, action: 'shop.created', entityId: shopId, after: toShopDto(created) });
      return created;
    });

    this.createLimiter.record(userId);
    await this.prisma.base.session.update({ where: { id: auth.sessionId }, data: { activeShopId: shop.id } });
    return toShopDto(shop);
  }
}
