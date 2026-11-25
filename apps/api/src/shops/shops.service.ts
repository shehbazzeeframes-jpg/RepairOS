import { Inject, Injectable, Logger } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { type CreateShopInput, DEFAULT_BUSINESS_HOURS, MARKET_DEFAULTS, type Shop } from '@repairos/contracts';
import { ensureTicketDefaults, type ScopedTx, type Shop as ShopRow } from '@repairos/db';
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
 * Sliding one-hour window of shop creations per user (§7 SC1.2). In-memory per process, acceptable until the
 * BACKLOG Redis-store item. M1: a slot is reserved before the create (so parallel requests can't all pass the
 * check) and released if the create fails.
 */
export class HourlyLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly max: number) {}

  private recent(key: string, now: number): number[] {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    this.hits.set(key, recent);
    return recent;
  }

  isLimited(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  /** Takes a slot if one is free (check and take are one synchronous step). Returns the slot, or null. */
  tryReserve(key: string, now = Date.now()): number | null {
    const recent = this.recent(key, now);
    if (recent.length >= this.max) return null;
    recent.push(now);
    return now;
  }

  /** Gives back a slot taken by `tryReserve` (the create failed). */
  release(key: string, slot: number): void {
    const list = this.hits.get(key);
    const i = list?.indexOf(slot) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
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
   * hours, Sprint 2 ticket statuses and ticket settings), a "Main" location, the caller's OWNER membership and an audit entry in one transaction, then makes
   * it the session's active shop. §7: at most `shopOwnedLimit` owned shops and `shopCreatePerHour` per hour.
   */
  async create(auth: AuthContext, input: CreateShopInput): Promise<Shop> {
    const userId = auth.user.id;
    // Fast path; the authoritative check is repeated under the per-user lock inside the transaction (M1).
    const memberships = await this.prisma.membershipsOf(userId);
    const owned = memberships.filter((m) => m.status === 'ACTIVE' && m.role === 'OWNER').length;
    if (owned >= this.config.shopOwnedLimit) this.blockedByCap(userId, owned);

    const market = MARKET_DEFAULTS[input.country];
    const timezone = canonicalTimeZone(input.timezone ?? market.timezone);
    if (!timezone) throw validationFailed([{ path: ['timezone'], message: 'Unknown time zone' }]);

    // M1: reserve the hourly slot before creating, so N parallel requests can't all pass the check.
    const slot = this.createLimiter.tryReserve(userId);
    if (slot === null) {
      this.logger.warn(`shop.create_blocked user=${userId} reason=rate_limited`);
      throw new ApiException(429, 'RATE_LIMITED', 'Too many shops created. Try again later.');
    }

    const shopId = createId();
    const db = this.prisma.forShop({ shopId, userId });

    let shop: ShopRow;
    try {
      shop = await db.tx(async (tx) => {
        // M1: one shop creation per user at a time; re-count owned ACTIVE shops under the lock. The tx has
        // app.user_id set, so RLS (memberships_self_read) lets it see all of this user's memberships.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop-create:${userId}`}))`;
        const [row] = await tx.$queryRaw<{ owned: number }[]>`
          SELECT count(*)::int AS owned FROM "memberships"
          WHERE "userId" = ${userId} AND "status" = 'ACTIVE' AND "role" = 'OWNER'`;
        if ((row?.owned ?? 0) >= this.config.shopOwnedLimit) this.blockedByCap(userId, row?.owned ?? 0);
        return this.insertShop(tx, shopId, userId, input, timezone);
      });
    } catch (err) {
      this.createLimiter.release(userId, slot);
      throw err;
    }

    await this.prisma.base.session.update({ where: { id: auth.sessionId }, data: { activeShopId: shop.id } });
    return toShopDto(shop);
  }

  private blockedByCap(userId: string, owned: number): never {
    // shop.create_blocked is not audited (no shop exists): app log only.
    this.logger.warn(`shop.create_blocked user=${userId} owned=${owned} limit=${this.config.shopOwnedLimit}`);
    throw apiError('SHOP_LIMIT_REACHED');
  }

  private async insertShop(tx: ScopedTx, shopId: string, userId: string, input: CreateShopInput, timezone: string): Promise<ShopRow> {
    const market = MARKET_DEFAULTS[input.country];
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
    // Sprint 2: default ticket statuses (contracts DEFAULT_TICKET_STATUSES) and ticket settings (next number 1001).
    await ensureTicketDefaults(tx, shopId);
    await writeAudit(tx, { shopId, actorUserId: userId, action: 'shop.created', entityId: shopId, after: toShopDto(created) });
    return created;
  }
}
