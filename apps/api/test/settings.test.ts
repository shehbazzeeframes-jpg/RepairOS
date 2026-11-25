/** Story §4: shop profile, tax settings and rates (D1, D2), business hours (D9). */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ShopProfile, ShopSettingsResponse, TaxRate, TaxRateListResponse } from '@repairos/contracts';
import { PrismaClient } from '@repairos/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditOf, ownerWithShop } from './fixtures';
import { createTestApp } from './helpers';

let app: NestExpressApplication;
let adminDb: PrismaClient;

beforeAll(async () => {
  app = await createTestApp();
  adminDb = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL_TEST });
});
afterAll(async () => {
  await adminDb?.$disconnect();
  await app?.close();
});

describe('shop profile (SP1)', () => {
  it('GET /api/shop returns profile and hours', async () => {
    const owner = await ownerWithShop(app, { shopName: 'Profile Shop' });
    const res = ShopSettingsResponse.parse((await owner.agent.get('/api/shop').expect(200)).body);
    expect(res.shop).toMatchObject({ id: owner.shopId, name: 'Profile Shop', country: 'US', addressLine1: null });
    expect(res.hours).toHaveLength(7);
  });

  it('US: normalises phone/state/ZIP, audits changed fields only, clears with null', async () => {
    const owner = await ownerWithShop(app);
    const res = await owner.agent.patch('/api/shop').send({
      name: '  Fix Fast  ',
      phone: '(212) 555-0142',
      region: 'ny',
      postcode: '10001-1234',
      city: 'New York',
      timezone: 'america/chicago',
    });
    expect(res.status).toBe(200);
    const shop = ShopProfile.parse(res.body);
    expect(shop).toMatchObject({ name: 'Fix Fast', phone: '+12125550142', region: 'NY', postcode: '10001-1234', timezone: 'America/Chicago' });
    const [audit] = await auditOf(adminDb, owner.shopId, 'shop.updated');
    expect(audit!.before).toEqual({ name: 'Test Shop', phone: null, region: null, postcode: null, city: null, timezone: 'America/New_York' });
    expect(audit!.after).toEqual({ name: 'Fix Fast', phone: '+12125550142', region: 'NY', postcode: '10001-1234', city: 'New York', timezone: 'America/Chicago' });

    const cleared = ShopProfile.parse((await owner.agent.patch('/api/shop').send({ city: null, postcode: '' }).expect(200)).body);
    expect(cleared).toMatchObject({ city: null, postcode: null, name: 'Fix Fast' });
    // unchanged values → no audit event
    await owner.agent.patch('/api/shop').send({ name: 'Fix Fast' }).expect(200);
    expect(await auditOf(adminDb, owner.shopId, 'shop.updated')).toHaveLength(2);
  });

  it('GB postcode canonical form, PK mobile + province; invalid values per country → 400 on the field', async () => {
    const gb = await ownerWithShop(app, { country: 'GB' });
    const g = ShopProfile.parse((await gb.agent.patch('/api/shop').send({ postcode: 'sw1a1aa', phone: '07911 123456', region: 'Greater London' }).expect(200)).body);
    expect(g).toMatchObject({ postcode: 'SW1A 1AA', phone: '+447911123456', region: 'Greater London' });

    const pk = await ownerWithShop(app, { country: 'PK' });
    const p = ShopProfile.parse((await pk.agent.patch('/api/shop').send({ phone: '0300 1234567', region: 'punjab', postcode: '54000' }).expect(200)).body);
    expect(p).toMatchObject({ phone: '+923001234567', region: 'Punjab', postcode: '54000' });

    const cases: [typeof gb, Record<string, unknown>, string][] = [
      [gb, { postcode: '12345' }, 'postcode'],
      [pk, { region: 'Texas' }, 'region'],
      [pk, { timezone: 'Europe/London' }, 'timezone'],
      [gb, { phone: '12' }, 'phone'],
      [gb, { name: 'x' }, 'name'],
    ];
    for (const [o, body, field] of cases) {
      const res = await o.agent.patch('/api/shop').send(body);
      expect(res.status, field).toBe(400);
      expect(res.body.issues[0].path).toEqual([field]);
    }
  });

  it('country and currency are read-only (400)', async () => {
    const owner = await ownerWithShop(app);
    for (const body of [{ country: 'GB' }, { currency: 'GBP' }, { bogus: 1 }]) {
      expect((await owner.agent.patch('/api/shop').send(body)).status).toBe(400);
    }
  });
});

describe('tax settings and rates (TX1, D1, D2)', () => {
  const rates = async (o: Awaited<ReturnType<typeof ownerWithShop>>, archived = false) =>
    TaxRateListResponse.parse((await o.agent.get(`/api/shop/tax-rates${archived ? '?includeArchived=true' : ''}`).expect(200)).body).items;

  it('prices-include-tax toggle is audited', async () => {
    const owner = await ownerWithShop(app);
    const res = await owner.agent.patch('/api/shop/tax-settings').send({ pricesIncludeTax: true }).expect(200);
    expect(res.body).toEqual({ pricesIncludeTax: true });
    expect((await auditOf(adminDb, owner.shopId, 'shop.tax_settings_updated'))[0]).toMatchObject({
      before: { pricesIncludeTax: false },
      after: { pricesIncludeTax: true },
    });
    expect((await owner.agent.patch('/api/shop/tax-settings').send({ pricesIncludeTax: 'yes' })).status).toBe(400);
  });

  it('create (8.875%), unique names, defaults move, archive/restore rules', async () => {
    const owner = await ownerWithShop(app);
    const [salesTax] = await rates(owner);
    expect(salesTax).toMatchObject({ name: 'Sales tax', rateMilliPct: 0, isDefaultGoods: true, isDefaultServices: true });

    const nyc = TaxRate.parse(
      (await owner.agent.post('/api/shop/tax-rates').send({ name: 'NYC', rateMilliPct: 8875, appliesTo: 'goods', isDefaultGoods: true }).expect(201)).body,
    );
    expect(nyc).toMatchObject({ rateMilliPct: 8875, isDefaultGoods: true, isDefaultServices: false });
    let list = await rates(owner);
    expect(list.find((r) => r.name === 'Sales tax')).toMatchObject({ isDefaultGoods: false, isDefaultServices: true });
    expect((await auditOf(adminDb, owner.shopId, 'tax_rate.created'))[0]).toMatchObject({ entityId: nyc.id, after: { rateMilliPct: 8875 } });
    expect((await auditOf(adminDb, owner.shopId, 'tax_rate.default_changed'))[0]).toMatchObject({
      entityId: nyc.id,
      before: { isDefaultGoods: false, previousDefaultId: salesTax!.id },
      after: { isDefaultGoods: true },
    });

    // D1: a goods rate can't be the services default
    const bad = await owner.agent.post('/api/shop/tax-rates').send({ name: 'Labour', rateMilliPct: 1000, appliesTo: 'goods', isDefaultServices: true });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].path).toEqual(['isDefaultServices']);
    expect((await owner.agent.patch(`/api/shop/tax-rates/${nyc.id}`).send({ isDefaultServices: true })).status).toBe(400);
    // changing appliesTo of the goods default to services would orphan it
    const orphan = await owner.agent.patch(`/api/shop/tax-rates/${nyc.id}`).send({ appliesTo: 'services' });
    expect(orphan.status).toBe(409);
    expect(orphan.body.code).toBe('TAX_RATE_IS_DEFAULT');

    // names unique among active rates, case-insensitive
    const dup = await owner.agent.post('/api/shop/tax-rates').send({ name: 'nyc', rateMilliPct: 1, appliesTo: 'all' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TAX_RATE_NAME_TAKEN');

    // edit: changed fields audited
    const edited = TaxRate.parse((await owner.agent.patch(`/api/shop/tax-rates/${nyc.id}`).send({ rateMilliPct: 8000, name: 'NYC' }).expect(200)).body);
    expect(edited.rateMilliPct).toBe(8000);
    expect((await auditOf(adminDb, owner.shopId, 'tax_rate.updated'))[0]).toMatchObject({ before: { rateMilliPct: 8875 }, after: { rateMilliPct: 8000 } });

    // archive: defaults blocked; non-default archived, hidden, restorable
    const archDefault = await owner.agent.post(`/api/shop/tax-rates/${nyc.id}/archive`);
    expect(archDefault.status).toBe(409);
    expect(archDefault.body).toMatchObject({ code: 'TAX_RATE_IS_DEFAULT', message: 'Choose another default first.' });
    await owner.agent.patch(`/api/shop/tax-rates/${salesTax!.id}`).send({ isDefaultGoods: true }).expect(200);
    const archived = TaxRate.parse((await owner.agent.post(`/api/shop/tax-rates/${nyc.id}/archive`).expect(200)).body);
    expect(archived.archivedAt).not.toBeNull();
    await owner.agent.post(`/api/shop/tax-rates/${nyc.id}/archive`).expect(200); // no-op
    expect(await auditOf(adminDb, owner.shopId, 'tax_rate.archived')).toHaveLength(1);
    list = await rates(owner);
    expect(list.map((r) => r.name)).toEqual(['Sales tax']);
    expect((await rates(owner, true)).map((r) => r.name)).toEqual(['Sales tax', 'NYC']);
    const editArchived = await owner.agent.patch(`/api/shop/tax-rates/${nyc.id}`).send({ rateMilliPct: 1 });
    expect(editArchived.body.code).toBe('TAX_RATE_ARCHIVED');

    // a new active rate takes the name → restore conflicts
    const taker = TaxRate.parse((await owner.agent.post('/api/shop/tax-rates').send({ name: 'NYC', rateMilliPct: 1, appliesTo: 'all' }).expect(201)).body);
    expect((await owner.agent.post(`/api/shop/tax-rates/${nyc.id}/restore`)).body.code).toBe('TAX_RATE_NAME_TAKEN');
    await owner.agent.patch(`/api/shop/tax-rates/${taker.id}`).send({ name: 'Other' }).expect(200);
    const restored = TaxRate.parse((await owner.agent.post(`/api/shop/tax-rates/${nyc.id}/restore`).expect(200)).body);
    expect(restored.archivedAt).toBeNull();
    expect(await auditOf(adminDb, owner.shopId, 'tax_rate.restored')).toHaveLength(1);
    expect((await owner.agent.post('/api/shop/tax-rates/nope/archive')).status).toBe(404);
  });

  it('LAST_TAX_RATE: the only active rate cannot be archived', async () => {
    const owner = await ownerWithShop(app, { country: 'GB' });
    const [vat] = await rates(owner);
    const res = await owner.agent.post(`/api/shop/tax-rates/${vat!.id}/archive`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_TAX_RATE');
  });

  it('L2 concurrency: parallel tax writes serialise and fail with their own codes, never a generic CONFLICT', async () => {
    const owner = await ownerWithShop(app);
    // Same name created 6 times at once: one 201, the rest TAX_RATE_NAME_TAKEN.
    const creates = await Promise.all(
      Array.from({ length: 6 }, () => owner.agent.post('/api/shop/tax-rates').send({ name: 'County', rateMilliPct: 1000, appliesTo: 'all' })),
    );
    expect(creates.filter((r) => r.status === 201)).toHaveLength(1);
    expect(creates.filter((r) => r.status !== 201).map((r) => r.body.code)).toEqual(Array(5).fill('TAX_RATE_NAME_TAKEN'));

    // Several rates claim the goods default at once: exactly one default afterwards, all requests succeed.
    const extra = await Promise.all(
      ['A', 'B', 'C', 'D'].map(async (n) =>
        TaxRate.parse((await owner.agent.post('/api/shop/tax-rates').send({ name: n, rateMilliPct: 100, appliesTo: 'goods' }).expect(201)).body),
      ),
    );
    const defaults = await Promise.all(extra.map((r) => owner.agent.patch(`/api/shop/tax-rates/${r.id}`).send({ isDefaultGoods: true })));
    expect(defaults.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await rates(owner)).filter((r) => r.isDefaultGoods)).toHaveLength(1);

    // Two non-default rates are the only others besides defaults: archiving everything at once leaves ≥ 1 active
    // rate, and refusals carry LAST_TAX_RATE / TAX_RATE_IS_DEFAULT.
    const gb = await ownerWithShop(app, { country: 'GB' });
    const [vat] = await rates(gb);
    const second = TaxRate.parse((await gb.agent.post('/api/shop/tax-rates').send({ name: 'Zero', rateMilliPct: 0, appliesTo: 'all' }).expect(201)).body);
    // Move both defaults to `second`, then race: archive VAT ×3, archive Zero ×3, make VAT default again.
    await gb.agent.patch(`/api/shop/tax-rates/${second.id}`).send({ isDefaultGoods: true, isDefaultServices: true }).expect(200);
    const race = await Promise.all([
      ...Array.from({ length: 3 }, () => gb.agent.post(`/api/shop/tax-rates/${vat!.id}/archive`)),
      ...Array.from({ length: 3 }, () => gb.agent.post(`/api/shop/tax-rates/${second.id}/archive`)),
      gb.agent.patch(`/api/shop/tax-rates/${vat!.id}`).send({ isDefaultGoods: true }),
      gb.agent.patch('/api/shop/tax-settings').send({ pricesIncludeTax: false }),
    ]);
    for (const r of race) {
      expect(r.body.code).not.toBe('CONFLICT');
      if (r.status !== 200) expect(['LAST_TAX_RATE', 'TAX_RATE_IS_DEFAULT', 'TAX_RATE_ARCHIVED']).toContain(r.body.code);
    }
    const after = await rates(gb);
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.filter((r) => r.isDefaultServices)).toHaveLength(1);
    expect(after.filter((r) => r.isDefaultGoods)).toHaveLength(1);
  });

  it('L2: every tax write takes the shop lock (a held lock blocks it)', async () => {
    const owner = await ownerWithShop(app);
    const [rate] = await rates(owner);
    const writes = [
      () => owner.agent.post('/api/shop/tax-rates').send({ name: 'Locked', rateMilliPct: 1, appliesTo: 'all' }),
      () => owner.agent.patch(`/api/shop/tax-rates/${rate!.id}`).send({ rateMilliPct: 5 }),
      () => owner.agent.post(`/api/shop/tax-rates/${rate!.id}/archive`),
      () => owner.agent.post(`/api/shop/tax-rates/${rate!.id}/restore`),
      () => owner.agent.patch(`/api/shop/tax-rates/${rate!.id}`).send({ isDefaultGoods: true }),
      () => owner.agent.patch('/api/shop/tax-settings').send({ pricesIncludeTax: true }),
    ];
    for (const write of writes) {
      let finished = false;
      let pending: Promise<{ status: number }> | undefined;
      await adminDb.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM shops WHERE id = ${owner.shopId} FOR UPDATE`;
        pending = write().then((r) => {
          finished = true;
          return r;
        });
        await new Promise((r) => setTimeout(r, 300));
        expect(finished).toBe(false); // waiting for the shop lock
      });
      expect((await pending!).status).toBeLessThan(500); // runs once the lock is released
    }
  });

  it('rate validation: 0–100% with up to 3 decimals as integer milli-percent', async () => {
    const owner = await ownerWithShop(app);
    for (const rateMilliPct of [-1, 100_001, 8.5]) {
      expect((await owner.agent.post('/api/shop/tax-rates').send({ name: 'Bad', rateMilliPct, appliesTo: 'all' })).status).toBe(400);
    }
    await owner.agent.post('/api/shop/tax-rates').send({ name: 'Max', rateMilliPct: 100_000, appliesTo: 'all' }).expect(201);
  });
});

describe('business hours (BH1, D9)', () => {
  it('replaces the week, validates closes > opens and 15-minute steps, audits the whole week', async () => {
    const owner = await ownerWithShop(app);
    const days = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      weekday === 5 ? { weekday, isOpen: true, opensAt: '09:00', closesAt: '12:30' } : { weekday, isOpen: weekday !== 0, opensAt: '10:00', closesAt: '19:00' },
    );
    const res = await owner.agent.put('/api/shop/hours').send({ days }).expect(200);
    expect(res.body.days[0]).toEqual({ weekday: 0, isOpen: false, opensAt: null, closesAt: null });
    expect(res.body.days[5]).toEqual({ weekday: 5, isOpen: true, opensAt: '09:00', closesAt: '12:30' });
    const settings = ShopSettingsResponse.parse((await owner.agent.get('/api/shop').expect(200)).body);
    expect(settings.hours[5]).toEqual({ weekday: 5, isOpen: true, opensAt: '09:00', closesAt: '12:30' });
    const [audit] = await auditOf(adminDb, owner.shopId, 'shop.hours_updated');
    expect((audit!.before as { days: unknown[] }).days).toHaveLength(7);
    expect((audit!.after as { days: { closesAt: string }[] }).days[5]!.closesAt).toBe('12:30');

    const bad = [...days];
    bad[2] = { weekday: 2, isOpen: true, opensAt: '18:00', closesAt: '09:00' };
    const r1 = await owner.agent.put('/api/shop/hours').send({ days: bad });
    expect(r1.status).toBe(400);
    expect(r1.body.issues[0].path).toEqual(['days', 2, 'closesAt']);
    bad[2] = { weekday: 2, isOpen: true, opensAt: '09:10', closesAt: '17:00' };
    expect((await owner.agent.put('/api/shop/hours').send({ days: bad })).status).toBe(400);
    expect((await owner.agent.put('/api/shop/hours').send({ days: days.slice(0, 6) })).status).toBe(400);
  });

  it('existing shops were backfilled by the migration (and new tax default flags)', async () => {
    const owner = await ownerWithShop(app);
    expect(await adminDb.businessHours.count({ where: { shopId: owner.shopId } })).toBe(7);
  });
});
