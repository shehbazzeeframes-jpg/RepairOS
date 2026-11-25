/**
 * Dev seed (idempotent). Runs as the table owner (DATABASE_URL), so RLS does not apply here.
 *  - "Demo Phone Repair" (US), owner owner@demo.test / Password123!
 *  - "Lahore Mobile Clinic" (PK), owner owner.pk@demo.test / Password123!  (second tenant for isolation testing)
 */
import { PrismaClient, type CountryCode, type Role } from '@prisma/client';
import { hashPassword } from 'better-auth/crypto';
import { MARKET_DEFAULTS } from '@repairos/contracts';

const PASSWORD = 'Password123!';

interface SeedShop {
  id: string;
  name: string;
  country: CountryCode;
  phone: string;
  addressLine1: string;
  city: string;
  postcode: string;
  owner: { id: string; name: string; email: string };
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

async function upsertUser(prisma: PrismaClient, u: SeedShop['owner'], passwordHash: string) {
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
    const role: Role = 'OWNER';
    await tx.membership.upsert({
      where: { userId_shopId: { userId: owner.id, shopId: s.id } },
      update: { role },
      create: { userId: owner.id, shopId: s.id, role },
    });
    await tx.taxRate.deleteMany({ where: { shopId: s.id } });
    await tx.taxRate.createMany({ data: d.taxRates.map((t) => ({ shopId: s.id, ...t })) });
  });
  console.log(`[seed] ${s.name} (${s.country}) owner ${s.owner.email}`);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo users and shops with NODE_ENV=production');
  }
  const prisma = new PrismaClient();
  try {
    const passwordHash = await hashPassword(PASSWORD);
    for (const s of SHOPS) await seedShop(prisma, s, passwordHash);
    console.log(`[seed] done. Password for both owners: ${PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
