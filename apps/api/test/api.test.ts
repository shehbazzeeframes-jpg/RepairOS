import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiError, HealthResponse, MeResponse, Shop } from '@repairos/contracts';
import { PrismaClient, tenantDb } from '@repairos/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentFor, createTestApp, signUp } from './helpers';

let app: NestExpressApplication;
let appDb: PrismaClient; // connects as repairos_app, like the API

beforeAll(async () => {
  app = await createTestApp();
  appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST });
});

afterAll(async () => {
  await appDb?.$disconnect();
  await app?.close();
});

describe('health', () => {
  it('is public and matches the contract', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(res.body)).toMatchObject({ status: 'ok', db: 'up' });
  });
});

describe('authentication', () => {
  it('GET /api/me returns 401 UNAUTHENTICATED without a session', async () => {
    const res = await request(app.getHttpServer()).get('/api/me');
    expect(res.status).toBe(401);
    expect(ApiError.parse(res.body)).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
  });

  it('POST /api/shops returns 401 without a session', async () => {
    const res = await request(app.getHttpServer()).post('/api/shops').send({ name: 'Nope', country: 'US' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('unknown routes return the ApiError shape (404 NOT_FOUND)', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).code).toBe('NOT_FOUND');
  });
});

describe('onboarding: sign up → create shop → me', () => {
  it('creates a US shop with market defaults and makes the caller OWNER of the active shop', async () => {
    const agent = agentFor(app);
    const { email, userId } = await signUp(agent, 'Ava Owner');

    const before = MeResponse.parse((await agent.get('/api/me').expect(200)).body);
    expect(before).toMatchObject({ user: { id: userId, email }, memberships: [], activeShop: null, role: null });

    const created = await agent
      .post('/api/shops')
      .send({ name: '  Fix It Fast ', country: 'US', phone: '(212) 555-0123', city: 'New York' });
    expect(created.status).toBe(201);
    const shop = Shop.parse(created.body);
    expect(shop).toMatchObject({
      name: 'Fix It Fast',
      country: 'US',
      currency: 'USD',
      locale: 'en-US',
      timezone: 'America/New_York',
      pricesIncludeTax: false,
      phone: '+12125550123',
    });

    const me = MeResponse.parse((await agent.get('/api/me').expect(200)).body);
    expect(me.activeShop?.id).toBe(shop.id);
    expect(me.role).toBe('OWNER');
    expect(me.memberships).toEqual([{ shopId: shop.id, shopName: 'Fix It Fast', role: 'OWNER' }]);

    // Main location, OWNER membership, tax rate and audit log were written for this shop.
    const db = tenantDb(appDb, { shopId: shop.id, userId });
    const [locations, taxRates, audit] = await db.tx(async (tx) =>
      Promise.all([tx.location.findMany(), tx.taxRate.findMany(), tx.auditLog.findMany()]),
    );
    expect(locations.map((l) => l.name)).toEqual(['Main']);
    expect(taxRates.map((t) => [t.name, t.rateBps, t.appliesTo])).toEqual([['Sales tax', 0, 'all']]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'shop.created', entityType: 'Shop', entityId: shop.id, actorUserId: userId });

    // A new session (fresh sign-in) lands on the user's shop instead of onboarding.
    const second = agentFor(app);
    await second.post('/api/auth/sign-in/email').send({ email, password: 'Password123!' }).expect(200);
    const again = MeResponse.parse((await second.get('/api/me').expect(200)).body);
    expect(again.activeShop?.id).toBe(shop.id);
    expect(again.role).toBe('OWNER');
  });

  it('PK shop gets PKR, Asia/Karachi and two tax rates (goods + services)', async () => {
    const agent = agentFor(app);
    const { userId } = await signUp(agent);
    const res = await agent.post('/api/shops').send({ name: 'Lahore Mobile', country: 'PK', phone: '0300 1234567' });
    expect(res.status).toBe(201);
    const shop = Shop.parse(res.body);
    expect(shop).toMatchObject({ currency: 'PKR', timezone: 'Asia/Karachi', pricesIncludeTax: false, phone: '+923001234567' });

    const rates = await tenantDb(appDb, { shopId: shop.id, userId }).client.taxRate.findMany({ orderBy: { rateBps: 'desc' } });
    expect(rates.map((t) => [t.name, t.rateBps, t.appliesTo])).toEqual([
      ['GST', 1800, 'goods'],
      ['Sales tax on services', 1600, 'services'],
    ]);
  });

  it('GB shop gets GBP, VAT 20% and tax-inclusive prices', async () => {
    const agent = agentFor(app);
    const { userId } = await signUp(agent);
    const res = await agent.post('/api/shops').send({ name: 'London Fix', country: 'GB', phone: '020 7946 0958' });
    expect(res.status).toBe(201);
    const shop = Shop.parse(res.body);
    expect(shop).toMatchObject({ currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', pricesIncludeTax: true, phone: '+442079460958' });

    const rates = await tenantDb(appDb, { shopId: shop.id, userId }).client.taxRate.findMany();
    expect(rates.map((t) => [t.name, t.rateBps, t.appliesTo])).toEqual([['VAT', 2000, 'all']]);
  });
});

describe('validation errors', () => {
  it('returns VALIDATION_FAILED with issues for a bad CreateShopInput', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.post('/api/shops').send({ name: 'x', country: 'FR' });
    expect(res.status).toBe(400);
    const body = ApiError.parse(res.body);
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.issues?.map((i) => i.path)).toEqual(expect.arrayContaining([['name'], ['country']]));
  });

  it('rejects an invalid phone for the shop country', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.post('/api/shops').send({ name: 'Phone Fix', country: 'GB', phone: '12' });
    expect(res.status).toBe(400);
    expect(ApiError.parse(res.body)).toMatchObject({ code: 'VALIDATION_FAILED', issues: [{ path: ['phone'] }] });
  });

  it('rejects malformed JSON with the ApiError shape', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.post('/api/shops').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(ApiError.parse(res.body).code).toBe('VALIDATION_FAILED');
  });

  it('validates the active-shop body', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const res = await agent.post('/api/me/active-shop').send({});
    expect(res.status).toBe(400);
    expect(ApiError.parse(res.body).issues?.[0]?.path).toEqual(['shopId']);
  });
});

describe('tenant isolation', () => {
  let shopA: string;
  let shopB: string;
  let userA: string;
  let agentA: ReturnType<typeof agentFor>;

  beforeAll(async () => {
    agentA = agentFor(app);
    userA = (await signUp(agentA, 'Owner A')).userId;
    shopA = Shop.parse((await agentA.post('/api/shops').send({ name: 'Shop A', country: 'US' }).expect(201)).body).id;

    const agentB = agentFor(app);
    await signUp(agentB, 'Owner B');
    shopB = Shop.parse((await agentB.post('/api/shops').send({ name: 'Shop B', country: 'PK' }).expect(201)).body).id;
  });

  it('a user of shop A gets 403 when setting shop B as active, and stays on A', async () => {
    const res = await agentA.post('/api/me/active-shop').send({ shopId: shopB });
    expect(res.status).toBe(403);
    expect(ApiError.parse(res.body).code).toBe('FORBIDDEN');

    const me = MeResponse.parse((await agentA.get('/api/me').expect(200)).body);
    expect(me.activeShop?.id).toBe(shopA);
    expect(me.memberships.map((m) => m.shopId)).toEqual([shopA]);
  });

  it('a member can switch to a shop they belong to', async () => {
    const second = Shop.parse((await agentA.post('/api/shops').send({ name: 'Shop A2', country: 'GB' }).expect(201)).body);
    const switched = MeResponse.parse((await agentA.post('/api/me/active-shop').send({ shopId: shopA }).expect(200)).body);
    expect(switched.activeShop?.id).toBe(shopA);
    expect(switched.memberships.map((m) => m.shopId).sort()).toEqual([shopA, second.id].sort());
  });

  it('the scoped client for shop A cannot read or write shop B rows', async () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });

    const rates = await db.client.taxRate.findMany();
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((r) => r.shopId === shopA)).toBe(true);

    expect(await db.client.taxRate.findMany({ where: { shopId: shopB } })).toEqual([]);
    expect(await db.client.shop.findUnique({ where: { id: shopB } })).toBeNull();
    expect(await db.client.membership.count({ where: { shopId: shopB } })).toBe(0);
    await expect(db.client.location.create({ data: { shopId: shopB, name: 'Sneaky' } })).rejects.toThrow(/another shop/);
    await expect(
      db.client.taxRate.updateMany({ where: {}, data: { shopId: shopB } }),
    ).rejects.toThrow(/another shop/);
  });

  it('the extension also scopes queries inside a tenant transaction', async () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });
    await expect(
      db.tx((tx) => tx.location.create({ data: { shopId: shopB, name: 'Sneaky' } })),
    ).rejects.toThrow(/TenantScopeError|another shop/);
    const found = await db.tx((tx) => tx.location.findMany({ where: { shopId: shopB } }));
    expect(found).toEqual([]);
  });

  it('RLS hides tenant rows from the app role without a shop context', async () => {
    expect(await appDb.taxRate.count()).toBe(0);
    expect(await appDb.shop.count()).toBe(0);
    expect(await appDb.auditLog.count()).toBe(0);
  });

  it('RLS blocks raw cross-tenant reads and writes even inside a shop A transaction', async () => {
    const rows = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.shop_id', ${shopA}, true)`;
      return tx.$queryRaw<{ shopId: string }[]>`SELECT "shopId" FROM tax_rates WHERE "shopId" = ${shopB}`;
    });
    expect(rows).toEqual([]);

    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${shopA}, true)`;
        await tx.$executeRaw`INSERT INTO tax_rates (id, "shopId", name, "rateBps", "appliesTo", "updatedAt") VALUES ('x', ${shopB}, 'Evil', 1, 'all', now())`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('the app role cannot rewrite the audit log', async () => {
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${shopA}, true)`;
        await tx.$executeRaw`DELETE FROM audit_logs`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('auth rate limiting', () => {
  it('returns 429 RATE_LIMITED after too many sign-in attempts', async () => {
    const limited = await createTestApp({ authRateLimitMax: 2 });
    try {
      const agent = agentFor(limited);
      const attempt = () => agent.post('/api/auth/sign-in/email').send({ email: 'nobody@test.repairos.dev', password: 'wrong-password' });
      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(401);
      const third = await attempt();
      expect(third.status).toBe(429);
      expect(ApiError.parse(third.body).code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
