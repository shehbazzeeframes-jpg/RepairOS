/**
 * Dev seed (idempotent). Runs as the table owner (DATABASE_URL), so RLS does not apply here.
 *  - "Demo Phone Repair" (US), owner owner@demo.test, plus staff:
 *      manager@demo.test (Manager), frontdesk@demo.test (Front desk), tech@demo.test (Technician),
 *      former@demo.test (Technician, DEACTIVATED), and a pending invite for new.hire@demo.test (Front desk).
 *    Time entries over the last two weeks (one > 14h "Long shift"), and the audit events these actions write.
 *  - "Lahore Mobile Clinic" (PK), owner owner.pk@demo.test (second tenant for isolation testing)
 * Every password is Password123!
 */
import { createHash, randomBytes } from 'node:crypto';
import { type CountryCode, type Prisma, PrismaClient, type Role } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { DEFAULT_BUSINESS_HOURS, MARKET_DEFAULTS } from '@repairos/contracts';

const PASSWORD = 'Password123!';

interface SeedUser {
  id: string;
  name: string;
  email: string;
}

interface SeedShop {
  id: string;
  name: string;
  country: CountryCode;
  phone: string;
  addressLine1: string;
  city: string;
  postcode: string;
  owner: SeedUser;
}

const SHOPS: SeedShop[] = [
  {
    id: 'seed_shop_us_demo',
    name: 'Demo Phone Repair',
    country: 'US',
    phone: '+12125550123',
    addressLine1: '123 Broadway',
    city: 'New York',
    postcode: '10001',
    owner: { id: 'seed_user_us_owner', name: 'Demo Owner', email: 'owner@demo.test' },
  },
  {
    id: 'seed_shop_pk_demo',
    name: 'Lahore Mobile Clinic',
    country: 'PK',
    phone: '+923001234567',
    addressLine1: 'Hall Road',
    city: 'Lahore',
    postcode: '54000',
    owner: { id: 'seed_user_pk_owner', name: 'PK Owner', email: 'owner.pk@demo.test' },
  },
];

/** Staff of the US demo shop. */
const US_STAFF: (SeedUser & { role: Role; deactivated?: boolean })[] = [
  { id: 'seed_user_us_manager', name: 'Maria Manager', email: 'manager@demo.test', role: 'MANAGER' },
  { id: 'seed_user_us_frontdesk', name: 'Frank Desk', email: 'frontdesk@demo.test', role: 'FRONT_DESK' },
  { id: 'seed_user_us_tech', name: 'Tina Tech', email: 'tech@demo.test', role: 'TECHNICIAN' },
  { id: 'seed_user_us_former', name: 'Fred Former', email: 'former@demo.test', role: 'TECHNICIAN', deactivated: true },
];

const PENDING_INVITE_EMAIL = 'new.hire@demo.test';

async function upsertUser(prisma: PrismaClient, u: SeedUser, passwordHash: string) {
  const user = await prisma.user.upsert({
    where: { email: u.email },
    update: { name: u.name },
    create: { id: u.id, name: u.name, email: u.email, emailVerified: true },
  });
  const account = await prisma.account.findFirst({ where: { userId: user.id, providerId: 'credential' } });
  if (account) {
    await prisma.account.update({ where: { id: account.id }, data: { password: passwordHash } });
  } else {
    await prisma.account.create({
      data: { id: `${user.id}_credential`, accountId: user.id, providerId: 'credential', userId: user.id, password: passwordHash },
    });
  }
  return user;
}

async function seedShop(prisma: PrismaClient, s: SeedShop, passwordHash: string) {
  const d = MARKET_DEFAULTS[s.country];
  const owner = await upsertUser(prisma, s.owner, passwordHash);
  await prisma.$transaction(async (tx) => {
    const shopData = {
      name: s.name,
      country: s.country,
      currency: d.currency,
      locale: d.locale,
      timezone: d.timezone,
      pricesIncludeTax: d.pricesIncludeTax,
      phone: s.phone,
      addressLine1: s.addressLine1,
      city: s.city,
      postcode: s.postcode,
    };
    await tx.shop.upsert({ where: { id: s.id }, update: shopData, create: { id: s.id, ...shopData } });
    await tx.location.upsert({
      where: { id: `${s.id}_main` },
      update: {},
      create: { id: `${s.id}_main`, shopId: s.id, name: 'Main', isPrimary: true },
    });
    await tx.membership.upsert({
      where: { userId_shopId: { userId: owner.id, shopId: s.id } },
      update: { role: 'OWNER', status: 'ACTIVE', deactivatedAt: null, deactivatedByUserId: null },
      create: { userId: owner.id, shopId: s.id, role: 'OWNER' },
    });
    await tx.taxRate.deleteMany({ where: { shopId: s.id } });
    await tx.taxRate.createMany({
      data: d.taxRates.map((t) => ({
        shopId: s.id,
        name: t.name,
        rateMilliPct: t.rateMilliPct,
        appliesTo: t.appliesTo,
        isDefaultGoods: t.isDefaultGoods,
        isDefaultServices: t.isDefaultServices,
      })),
    });
    for (const day of DEFAULT_BUSINESS_HOURS) {
      const data = { isOpen: day.isOpen, opensAt: day.opensAt, closesAt: day.closesAt };
      await tx.businessHours.upsert({
        where: { shopId_weekday: { shopId: s.id, weekday: day.weekday } },
        update: data,
        create: { shopId: s.id, weekday: day.weekday, ...data },
      });
    }
  });
  console.log(`[seed] ${s.name} (${s.country}) owner ${s.owner.email}`);
  return owner;
}

// ---------- US demo shop: staff, invite, time entries, audit ----------

/** UTC instant of `hh:mm` shop-local time on the shop-local date `daysAgo` days before today. */
function localInstant(timeZone: string, daysAgo: number, hh: number, mm: number): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const date = new Date(`${fmt.format(new Date())}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  const guess = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hh, mm);
  const offset = (at: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
        .formatToParts(new Date(at))
        .filter((x) => x.type !== 'literal')
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!) - Math.floor(at / 60_000) * 60_000;
  };
  return new Date(guess - offset(guess - offset(guess)));
}

const weekdayOf = (instant: Date, timeZone: string) =>
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant));

async function seedUsStaff(prisma: PrismaClient, shop: SeedShop, ownerId: string, passwordHash: string) {
  const tz = MARKET_DEFAULTS[shop.country].timezone;
  const users = new Map<string, string>();
  for (const s of US_STAFF) users.set(s.email, (await upsertUser(prisma, s, passwordHash)).id);

  await prisma.$transaction(async (tx) => {
    // Seed-owned rows are recreated on every run (ids start with "seed_").
    await tx.auditLog.deleteMany({ where: { shopId: shop.id, id: { startsWith: 'seed_' } } });
    await tx.timeEntry.deleteMany({ where: { shopId: shop.id } });
    await tx.invitation.deleteMany({ where: { shopId: shop.id, id: { startsWith: 'seed_' } } });

    const memberships = new Map<string, string>();
    for (const s of US_STAFF) {
      const userId = users.get(s.email)!;
      const deactivatedAt = s.deactivated ? localInstant(tz, 2, 17, 0) : null;
      const m = await tx.membership.upsert({
        where: { userId_shopId: { userId, shopId: shop.id } },
        update: { role: s.role, status: s.deactivated ? 'DEACTIVATED' : 'ACTIVE', deactivatedAt, deactivatedByUserId: s.deactivated ? ownerId : null },
        create: {
          userId,
          shopId: shop.id,
          role: s.role,
          status: s.deactivated ? 'DEACTIVATED' : 'ACTIVE',
          deactivatedAt,
          deactivatedByUserId: s.deactivated ? ownerId : null,
        },
      });
      memberships.set(s.email, m.id);
    }

    const audits: Prisma.AuditLogCreateManyInput[] = [];
    let n = 0;
    const audit = (a: Omit<Prisma.AuditLogCreateManyInput, 'id' | 'shopId'>) =>
      audits.push({ id: `seed_audit_${String(++n).padStart(3, '0')}`, shopId: shop.id, ...a });

    // Pending invite (its token is random and not stored anywhere: use "Copy link" or "Resend" to get one).
    const inviteCreatedAt = localInstant(tz, 1, 11, 15);
    const inviteExpiresAt = new Date(inviteCreatedAt.getTime() + 7 * 24 * 3600 * 1000);
    await tx.invitation.create({
      data: {
        id: 'seed_invite_new_hire',
        shopId: shop.id,
        email: PENDING_INVITE_EMAIL,
        role: 'FRONT_DESK',
        tokenHash: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('hex'),
        expiresAt: inviteExpiresAt,
        invitedByUserId: ownerId,
        lastSentAt: inviteCreatedAt,
        sendCount: 1,
        emailStatus: 'SENT',
        createdAt: inviteCreatedAt,
      },
    });
    audit({
      actorUserId: ownerId,
      action: 'invite.created',
      entityType: 'Invitation',
      entityId: 'seed_invite_new_hire',
      after: { email: PENDING_INVITE_EMAIL, role: 'FRONT_DESK', expiresAt: inviteExpiresAt.toISOString() },
      createdAt: inviteCreatedAt,
    });

    // Two weeks of shifts, Mon–Sat, 09:00–17:30 shop time (with a little variety).
    const entries: Prisma.TimeEntryCreateManyInput[] = [];
    const shift = (email: string, daysAgo: number, inH: number, inM: number, outH: number, outM: number, extra: Partial<Prisma.TimeEntryCreateManyInput> = {}) => {
      const userId = users.get(email)!;
      const clockInAt = localInstant(tz, daysAgo, inH, inM);
      let clockOutAt = localInstant(tz, daysAgo, outH, outM);
      if (clockOutAt <= clockInAt) clockOutAt = new Date(clockOutAt.getTime() + 24 * 3600 * 1000);
      const e = { id: `seed_te_${entries.length + 1}`, shopId: shop.id, userId, clockInAt, clockOutAt, source: 'SELF' as const, createdByUserId: userId, ...extra };
      entries.push(e);
      return e;
    };
    for (let daysAgo = 1; daysAgo <= 14; daysAgo++) {
      if (weekdayOf(localInstant(tz, daysAgo, 12, 0), tz) === 0) continue; // closed Sundays
      shift('manager@demo.test', daysAgo, 9, 0, 17, 30);
      shift('frontdesk@demo.test', daysAgo, 9, 55 + (daysAgo % 3), 18, 5);
      if (daysAgo === 6) shift('tech@demo.test', daysAgo, 8, 30, 23, 15); // 14h45: "Long shift"
      else shift('tech@demo.test', daysAgo, 10, 0, 18, 30 + (daysAgo % 4) * 5);
      if (daysAgo > 2) shift('former@demo.test', daysAgo, 10, 0, 16, 0);
    }
    // The former technician was clocked in when deactivated: closed automatically (D8).
    const autoClosed = shift('former@demo.test', 2, 10, 0, 17, 0, { closedReason: 'DEACTIVATED' });
    // A manual correction by the owner.
    const manual = shift('frontdesk@demo.test', 13, 13, 0, 17, 0, {
      id: 'seed_te_manual',
      source: 'MANUAL',
      createdByUserId: ownerId,
      editedAt: localInstant(tz, 12, 9, 30),
      editedByUserId: ownerId,
      editReason: 'Forgot to clock in after lunch',
    });
    // Remove the regular shift that the manual one replaces (same day) to avoid an overlap.
    const sameDay = entries.findIndex((e) => e !== manual && e.userId === manual.userId && (e.clockInAt as Date).getTime() === localInstant(tz, 13, 9, 55 + (13 % 3)).getTime());
    if (sameDay >= 0) entries.splice(sameDay, 1);
    await tx.timeEntry.createMany({ data: entries });

    audit({
      actorUserId: ownerId,
      action: 'time_entry.created',
      entityType: 'TimeEntry',
      entityId: 'seed_te_manual',
      after: {
        userId: manual.userId,
        clockInAt: (manual.clockInAt as Date).toISOString(),
        clockOutAt: (manual.clockOutAt as Date).toISOString(),
        source: 'MANUAL',
        reason: 'Forgot to clock in after lunch',
      },
      createdAt: manual.editedAt as Date,
    });
    const deactivatedAt = localInstant(tz, 2, 17, 0);
    audit({
      actorUserId: ownerId,
      action: 'member.deactivated',
      entityType: 'Membership',
      entityId: memberships.get('former@demo.test')!,
      before: { status: 'ACTIVE' },
      after: { status: 'DEACTIVATED' },
      createdAt: deactivatedAt,
    });
    audit({
      actorUserId: ownerId,
      action: 'time_entry.auto_closed',
      entityType: 'TimeEntry',
      entityId: autoClosed.id!,
      before: { userId: autoClosed.userId, clockInAt: (autoClosed.clockInAt as Date).toISOString(), clockOutAt: null, closedReason: null },
      after: { clockOutAt: deactivatedAt.toISOString(), closedReason: 'DEACTIVATED' },
      createdAt: deactivatedAt,
    });
    await tx.auditLog.createMany({ data: audits });
    console.log(`[seed]   staff: ${US_STAFF.map((s) => `${s.email}${s.deactivated ? ' (deactivated)' : ''}`).join(', ')}`);
    console.log(`[seed]   pending invite: ${PENDING_INVITE_EMAIL}; ${entries.length} time entries; ${audits.length} audit events`);
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo users and shops with NODE_ENV=production');
  }
  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(PASSWORD);
    for (const s of SHOPS) {
      const owner = await seedShop(prisma, s, passwordHash);
      if (s.country === 'US') await seedUsStaff(prisma, s, owner.id, passwordHash);
    }
    console.log(`[seed] done. Password for every demo user: ${PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
