import { expect, test } from '@playwright/test';
import { createShopApi, signInContext, sql } from './support/stack';
import { axe, call, checkIn, customer, freshShop, imei, member, ok, phone, shot2 } from './support/sprint2';

/** §7 global search (GS1) and §8.1 stale-tab shop guard (A13 / BK1). */

test('GS-01 ⌘K palette: grouped results, Enter on an exact ticket number / IMEI jumps there, Recent, Esc; "/" opens it', async ({ page }) => {
  const s = await freshShop('US', 'Search');
  const theImei = imei(Date.now() + 909);
  const t = await checkIn(s.owner.ctx, {
    newCustomer: { kind: 'PERSON', firstName: 'Gloria', lastName: 'Searchwell', phones: [{ number: '(212) 555-0144' }] },
    newDevice: { type: 'PHONE', brand: 'Apple', model: 'iPhone 15 Pro', imei: theImei },
  });
  const t2 = await checkIn(s.owner.ctx, { customerId: t.customer.id, deviceId: t.device.id, issues: [{ code: 'BATTERY' }] });
  const arch = await customer(s.owner.ctx, { kind: 'PERSON', firstName: 'Gloria', lastName: 'Archivedone', phones: [{ number: phone('US') }] });
  await ok(s.owner.ctx, 'POST', `/api/customers/${arch.id}/archive`, {});

  const api = await ok(s.owner.ctx, 'GET', '/api/search?q=gloria');
  expect(api.customers.map((c: { displayName?: string; name?: string }) => c.displayName ?? c.name)).toEqual(['Gloria Searchwell']);
  expect(api.tickets.length).toBe(2);

  await signInContext(page, s.owner.email);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search RepairOS' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('gloria');
  await expect(palette.getByText('Customers')).toBeVisible();
  await expect(palette.getByRole('option', { name: /Gloria Searchwell/ }).first()).toBeVisible();
  await expect(palette.getByRole('option', { name: /Archivedone/ })).toHaveCount(0);
  await page.screenshot({ path: shot2('gs-01-palette') });
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Exact ticket number → Enter jumps.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type(t.numberLabel.toLowerCase().replace('-', ''));
  await expect(palette.getByRole('option', { name: new RegExp(t.numberLabel) }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tickets/${t.id}$`));

  // Full IMEI (scanner) → Enter opens the device's latest ticket.
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('/');
  await expect(palette).toBeVisible();
  await expect(palette.getByText('Recent')).toBeVisible();
  await expect(palette.getByRole('option', { name: new RegExp(t.numberLabel) }).first()).toBeVisible();
  await page.keyboard.type(theImei, { delay: 5 });
  await expect(palette.getByText('Devices')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tickets/(${t2.id}|${t.customer.id})$|/customers/${t.customer.id}`));
  test.info().annotations.push({ type: 'observed', description: `IMEI Enter went to ${page.url()} (latest ticket ${t2.id})` });
  expect(page.url()).toContain(t2.id);
  // Quick actions with an empty query.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette.getByRole('option', { name: 'New ticket' })).toBeVisible();
  await expect(palette.getByRole('option', { name: 'New customer' })).toBeVisible();
});

test('GS-02 technician: palette has no "New ticket"/"New customer" quick actions', async ({ page }) => {
  const s = await freshShop('US', 'SearchTech');
  const tech = await member(s, 'TECHNICIAN');
  await signInContext(page, tech.email);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search RepairOS' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option', { name: 'New ticket' })).toHaveCount(0);
  await expect(palette.getByRole('option', { name: 'New customer' })).toHaveCount(0);
});

test('SH-01 two tabs: switch shop in one, create in the other → 409 ACTIVE_SHOP_CHANGED, banner, nothing written to either shop', async ({ context }) => {
  const a = await freshShop('US', 'TabsA');
  const b = await createShopApi(a.owner.ctx, `QA Tabs B ${Date.now().toString(36)}`, 'GB');
  // createShop makes B active; go back to A for the start.
  await ok(a.owner.ctx, 'POST', '/api/me/active-shop', { shopId: a.shop.id });
  const c = await customer(a.owner.ctx, { kind: 'PERSON', firstName: 'Tabby', lastName: 'Twotabs', phones: [{ number: phone('US') }] });
  await ok(a.owner.ctx, 'POST', `/api/customers/${c.id}/devices`, { type: 'PHONE', brand: 'Apple', model: 'iPhone 12' });

  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await signInContext(tabA, a.owner.email);
  await ok(tabA.request, 'POST', '/api/me/active-shop', { shopId: a.shop.id });
  await tabB.goto('/tickets/new');
  await expect(tabB.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  await tabB.keyboard.type('tabby');
  await expect(tabB.getByRole('option', { name: /Tabby Twotabs/ })).toBeVisible();
  await tabB.keyboard.press('Enter');
  await expect(tabB.getByRole('radio', { name: /iPhone 12/ })).toBeFocused();
  await tabB.keyboard.press('Enter');
  await tabB.keyboard.type('scr');
  await tabB.keyboard.press('Enter');

  await tabA.goto('/');
  await tabA.getByRole('button', { name: `Account: ${a.owner.name}` }).click();
  await tabA.getByRole('menuitemradio', { name: new RegExp(b.name) }).click();
  await expect(tabA.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: b.name })).toBeVisible();

  const creates: number[] = [];
  tabB.on('response', (r) => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tickets') creates.push(r.status());
  });
  await tabB.keyboard.press('ControlOrMeta+Enter');
  await expect(tabB.getByText(`You're now working in ${b.name}. This page was reloaded.`)).toBeVisible();
  await tabB.screenshot({ path: shot2('sh-01-shop-changed-banner') });
  expect(creates).toEqual([409]);
  expect(sql(`select count(*) from tickets where "shopId" in ('${a.shop.id}','${b.id}')`)).toBe('0');
  // Draft kept under the original shop's key.
  const keys = await tabB.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('repairos:checkin-draft:')));
  expect(keys.some((k) => k.endsWith(a.shop.id))).toBe(true);
  expect(keys.some((k) => k.endsWith(b.id))).toBe(false);
});

test('SH-02 API: X-Shop-Id mismatch on reads and writes → 409 ACTIVE_SHOP_CHANGED; responses echo X-Shop-Id; no header still works', async () => {
  const a = await freshShop('PK', 'HeaderA');
  const b = await createShopApi(a.owner.ctx, `QA Header B ${Date.now().toString(36)}`, 'US');
  const me = await ok(a.owner.ctx, 'GET', '/api/me');
  expect(me.activeShop.id).toBe(b.id);
  const w = await call(a.owner.ctx, 'POST', '/api/customers', { kind: 'PERSON', firstName: 'Wrong', phones: [{ number: '0300 1234567' }] }, { 'X-Shop-Id': a.shop.id });
  expect(w.status).toBe(409);
  expect(w.body.code).toBe('ACTIVE_SHOP_CHANGED');
  const r = await call(a.owner.ctx, 'GET', '/api/tickets/counts', undefined, { 'X-Shop-Id': a.shop.id });
  expect(r.status).toBe(409);
  expect(sql(`select count(*) from customers where "firstName"='Wrong' and "shopId" in ('${a.shop.id}','${b.id}')`)).toBe('0');
  const good = await call(a.owner.ctx, 'GET', '/api/tickets/counts', undefined, { 'X-Shop-Id': b.id });
  expect(good.status).toBe(200);
  expect(good.headers['x-shop-id']).toBe(b.id);
  expect((await call(a.owner.ctx, 'GET', '/api/tickets/counts')).status).toBe(200);
});
