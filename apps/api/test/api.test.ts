import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiError, HealthResponse, MeResponse, Shop } from '@repairos/contracts';
import { PrismaClient, tenantDb } from '@repairos/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { agentFor, APP_URL, createTestApp, signUp, uniqueEmail } from './helpers';

let app: NestExpressApplication;
let appDb: PrismaClient; // connects as repairos_app, like the API
let adminDb: PrismaClient; // table owner, for setup/assertions that must bypass RLS

beforeAll(async () => {
  app = await createTestApp();
  appDb = new PrismaClient({ datasourceUrl: process.env.APP_DATABASE_URL_TEST });
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});

afterAll(async () => {
  await appDb?.$disconnect();
  await adminDb?.$disconnect();
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
    expect(me.memberships).toEqual([{ shopId: shop.id, shopName: 'Fix It Fast', role: 'OWNER', status: 'ACTIVE' }]);
    expect(me.permissions).toContain('settings.manage');
    expect(me.accessRemoved).toBeNull();

    // Main location, OWNER membership, tax rate and audit log were written for this shop.
    const db = tenantDb(appDb, { shopId: shop.id, userId });
    const [locations, taxRates, audit] = await db.tx(async (tx) =>
      Promise.all([tx.location.findMany(), tx.taxRate.findMany(), tx.auditLog.findMany()]),
    );
    expect(locations.map((l) => l.name)).toEqual(['Main']);
    expect(taxRates.map((t) => [t.name, t.rateMilliPct, t.appliesTo])).toEqual([['Sales tax', 0, 'all']]);
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

    const rates = await tenantDb(appDb, { shopId: shop.id, userId }).client.taxRate.findMany({ orderBy: { rateMilliPct: 'desc' } });
    expect(rates.map((t) => [t.name, t.rateMilliPct, t.appliesTo])).toEqual([
      ['GST', 18000, 'goods'],
      ['Sales tax on services', 16000, 'services'],
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
    expect(rates.map((t) => [t.name, t.rateMilliPct, t.appliesTo])).toEqual([['VAT', 20000, 'all']]);
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
    expect(ApiError.parse(res.body)).toEqual({ statusCode: 400, code: 'VALIDATION_FAILED', message: 'Malformed JSON body' });

    // Same on the auth routes (parsed by the rate-limit layer), without parser internals.
    const auth = await agentFor(app).post('/api/auth/sign-in/email').set('Content-Type', 'application/json').send('{"email":');
    expect(auth.status).toBe(400);
    expect(auth.body).toEqual({ statusCode: 400, code: 'VALIDATION_FAILED', message: 'Malformed JSON body' });
  });

  it('stores the canonical time zone and rejects unknown or offset zones', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const ok = await agent.post('/api/shops').send({ name: 'TZ Shop', country: 'GB', timezone: 'europe/london' });
    expect(ok.status).toBe(201);
    expect(Shop.parse(ok.body).timezone).toBe('Europe/London');
    for (const timezone of ['Mars/Olympus_Mons', '+05:00']) {
      const bad = await agent.post('/api/shops').send({ name: 'TZ Shop', country: 'GB', timezone });
      expect(bad.status, timezone).toBe(400);
      expect(ApiError.parse(bad.body).issues?.[0]?.path).toEqual(['timezone']);
    }
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

  it('a rollback inside db.tx discards tenant writes (atomic)', async () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });
    await expect(
      db.tx(async (tx) => {
        await tx.location.create({ data: { shopId: shopA, name: 'Rolled back' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.client.location.count({ where: { name: 'Rolled back' } })).toBe(0);
  });

  it('the scoped client does not expose $transaction or raw SQL', () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });
    const loose = db.client as unknown as Record<string, unknown>;
    expect(() => loose.$transaction).toThrow(/db\.tx|tx\(/);
    expect(() => loose.$executeRawUnsafe).toThrow(/not available/);
  });

  it('db.client inside db.tx runs on the transaction (sees and rolls back its writes)', async () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });
    const before = await db.client.location.count();
    await expect(
      db.tx(async (tx) => {
        await db.client.location.create({ data: { shopId: shopA, name: 'Via client in tx' } });
        expect(await tx.location.count()).toBe(before + 1);
        expect(await db.client.location.count()).toBe(before + 1);
        // A second tenantDb for the same shop joins the same transaction too.
        expect(await tenantDb(appDb, { shopId: shopA }).client.location.count()).toBe(before + 1);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await db.client.location.count()).toBe(before);
  });

  it('refuses auth tables and only reads users who are members of the shop', async () => {
    const db = tenantDb(appDb, { shopId: shopA, userId: userA });
    const loose = db.client as unknown as Record<string, { count: () => Promise<number> }>;
    for (const model of ['session', 'account', 'verification']) {
      await expect(loose[model]!.count()).rejects.toThrow(/auth table/);
    }
    const users = await db.client.user.findMany();
    expect(users.map((u) => u.id)).toEqual([userA]);
    expect(await adminDb.user.count()).toBeGreaterThan(1);
    await expect(db.client.user.update({ where: { id: userA }, data: { name: 'x' } })).rejects.toThrow(/read-only/);
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
        await tx.$executeRaw`INSERT INTO tax_rates (id, "shopId", name, "rateMilliPct", "appliesTo", "updatedAt") VALUES ('x', ${shopB}, 'Evil', 1, 'all', now())`;
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
  let limited: NestExpressApplication;
  beforeAll(async () => {
    limited = await createTestApp({ authRateLimitMax: 2 });
  });
  afterAll(async () => {
    await limited?.close();
  });

  const signIn = (email: string, password = 'wrong-password') =>
    request(limited.getHttpServer()).post('/api/auth/sign-in/email').set('Origin', APP_URL).send({ email, password });

  it('limits failed sign-ins per IP + normalised email', async () => {
    expect((await signIn('victim@test.repairos.dev')).status).toBe(401);
    expect((await signIn('VICTIM@Test.Repairos.dev')).status).toBe(401);
    const third = await signIn('victim@test.repairos.dev');
    expect(third.status).toBe(429);
    expect(ApiError.parse(third.body).code).toBe('RATE_LIMITED');
    // Another email from the same IP has its own bucket.
    expect((await signIn('other@test.repairos.dev')).status).toBe(401);
  });

  it('does not count successful sign-ins, and sign-up has a separate bucket', async () => {
    const email = uniqueEmail('ratelimit');
    const up = await request(limited.getHttpServer())
      .post('/api/auth/sign-up/email')
      .set('Origin', APP_URL)
      .send({ name: 'Rate Limit', email, password: 'Password123!' });
    expect(up.status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await signIn(email, 'Password123!')).status).toBe(200);
  });
});

describe('security hardening', () => {
  it('refuses to boot with a superuser / owner database role', async () => {
    await expect(createTestApp({ databaseUrl: process.env.DATABASE_URL_TEST })).rejects.toThrow(/Refusing to start/);
  });

  it('requires APP_DATABASE_URL and a strong auth secret outside tests', () => {
    const base = { BETTER_AUTH_SECRET: 'x'.repeat(40), APP_DATABASE_URL: 'postgresql://repairos_app:pw@localhost/db' };
    expect(() => loadConfig({ ...base, NODE_ENV: 'test', APP_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://repairos@x/db' })).toThrow(/APP_DATABASE_URL/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', BETTER_AUTH_SECRET: 'change-me' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'development', BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).trustProxy).toBe('loopback');
    expect(loadConfig({ ...base, NODE_ENV: 'test', TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('M2: refuses to start without an explicit NODE_ENV; outside development/test Resend is required', () => {
    const base = { BETTER_AUTH_SECRET: 'x'.repeat(40), APP_DATABASE_URL: 'postgresql://repairos_app:pw@localhost/db' };
    expect(() => loadConfig(base)).toThrow(/NODE_ENV/);
    expect(() => loadConfig({ ...base, NODE_ENV: '' })).toThrow(/NODE_ENV/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging', RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/);
    const prod = loadConfig({ ...base, NODE_ENV: 'production', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c', DEV_OUTBOX: '1' });
    expect(prod.email.provider).toBe('resend');
    expect(prod.devOutbox).toBe(true); // set, but the controller still refuses (see invites.test.ts)
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).devOutbox).toBe(false);
  });

  it('keeps a safe x-request-id and replaces an unsafe one', async () => {
    const ok = await request(app.getHttpServer()).get('/api/health').set('x-request-id', 'abc-123_DEF');
    expect(ok.headers['x-request-id']).toBe('abc-123_DEF');
    const bad = await request(app.getHttpServer()).get('/api/health').set('x-request-id', 'evil\tvalue {injected}');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const long = await request(app.getHttpServer()).get('/api/health').set('x-request-id', 'a'.repeat(65));
    expect(long.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('forwards the refreshed session cookie from getSession', async () => {
    const agent = agentFor(app);
    const { userId } = await signUp(agent);
    // Make the session old enough that Better Auth extends it on the next request.
    await adminDb.session.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() + 60 * 60 * 1000) } });
    const res = await agent.get('/api/me').expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('repairos.session_token='))).toBe(true);
    const session = await adminDb.session.findFirst({ where: { userId } });
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('the app role cannot delete a shop, and audit history blocks owner deletes too', async () => {
    const agent = agentFor(app);
    await signUp(agent);
    const shop = Shop.parse((await agent.post('/api/shops').send({ name: 'Keep Me', country: 'US' }).expect(201)).body);
    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.shop_id', ${shop.id}, true)`;
        await tx.$executeRaw`DELETE FROM shops WHERE id = ${shop.id}`;
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(adminDb.shop.delete({ where: { id: shop.id } })).rejects.toThrow(/audit_logs_shopId_fkey|Foreign key/i);
  });
});
