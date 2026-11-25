import { expect, test } from '@playwright/test';
import {
  addMemberApi,
  apiAs,
  auditEvents,
  createShopApi,
  inviteExistingApi,
  jsonHeaders,
  newOwnerShop,
  SEED,
  shot,
  signInContext,
  uniqueEmail,
} from './support/stack';

test.describe('Shop switcher (A3)', () => {
  test('SW-01 a user in two shops switches from the user menu; nav, permissions and clock follow the active shop', async ({
    page,
  }) => {
    const a = await newOwnerShop('US', 'Switcher');
    const b = await newOwnerShop('GB', 'OtherOwner');
    await inviteExistingApi(b.ctx, a.ctx, a.email, 'TECHNICIAN');
    await signInContext(page, a.email);
    await page.goto('/');
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(page.getByRole('button', { name: /Clocked in \d+m$/ })).toBeVisible();

    await page.getByRole('button', { name: `Account: ${a.name}` }).click();
    await expect(
      page.getByRole('menuitemradio', { name: new RegExp(a.shop.name) }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemradio', { name: new RegExp(b.shop.name) })).toBeVisible();
    await page.screenshot({ path: shot('sw-01-menu') });
    await page.getByRole('menuitemradio', { name: new RegExp(b.shop.name) }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: b.shop.name }),
    ).toBeVisible();
    // Technician in B: no Settings; clocked out in B even though clocked in at A.
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clock in' })).toBeVisible();
    const me = await (await page.request.get('/api/me')).json();
    expect(me.activeShop).toMatchObject({
      id: b.shop.id,
      currency: 'GBP',
      timezone: 'Europe/London',
    });
    expect(me.role).toBe('TECHNICIAN');

    // Back to A: still clocked in there.
    await page.getByRole('button', { name: `Account: ${a.name}` }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(a.shop.name) }).click();
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: a.shop.name }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Clocked in \d+m$/ })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
    ).toBeVisible();
  });
});

test.describe('Shop cap (SC1)', () => {
  test('CAP-01 owning 3 shops blocks the 4th (UI banner + API 403); memberships as staff do not count', async ({
    page,
  }) => {
    const u = await newOwnerShop('US', 'Capper'); // owns 1
    // Also staff (technician) in someone else's shop: must not count.
    const other = await newOwnerShop('PK', 'Other');
    await inviteExistingApi(other.ctx, u.ctx, u.email, 'TECHNICIAN');
    await createShopApi(u.ctx, `Cap two ${Date.now().toString(36)}`, 'GB'); // owns 2

    await signInContext(page, u.email);
    await page.goto('/');
    await page.getByRole('button', { name: `Account: ${u.name}` }).click();
    await page.getByRole('menuitem', { name: 'Create a new shop' }).click();
    await expect(page).toHaveURL(/\/onboarding\?new=1$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up another shop' }),
    ).toBeVisible();
    await page.getByLabel('Shop name').fill('Third Shop QA');
    await page.getByRole('combobox', { name: 'Country' }).click();
    await page.getByRole('option', { name: 'Pakistan' }).click();
    await page.getByRole('button', { name: 'Create shop' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'Third Shop QA' }),
    ).toBeVisible();

    // 4th: menu item disabled with the message, and the API refuses.
    await page.getByRole('button', { name: `Account: ${u.name}` }).click();
    const item = page.getByRole('menuitem', { name: /Create a new shop/ });
    await expect(item).toBeVisible();
    await page.screenshot({ path: shot('cap-01-menu-at-3') });
    const disabled = (await item.getAttribute('aria-disabled')) === 'true';
    test
      .info()
      .annotations.push({ type: 'menu item disabled at 3', description: String(disabled) });
    expect.soft(disabled, 'Create a new shop menu item is disabled at 3 owned shops').toBe(true);
    await page.keyboard.press('Escape');

    await page.goto('/onboarding?new=1');
    await page.getByLabel('Shop name').fill('Fourth Shop QA');
    await page.getByRole('combobox', { name: 'Country' }).click();
    await page.getByRole('option', { name: 'United Kingdom' }).click();
    await page.getByRole('button', { name: 'Create shop' }).click();
    await expect(
      page.getByText('You can own up to 3 shops for now. Contact support if you need more.'),
    ).toBeVisible();
    const res = await u.ctx.post('/api/shops', {
      headers: jsonHeaders,
      data: { name: 'Fifth', country: 'US' },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe('SHOP_LIMIT_REACHED');
  });

  test('CAP-02 a shop where the user is a deactivated owner does not count', async () => {
    const u = await newOwnerShop('US', 'Deowned');
    // Another owner in u's first shop deactivates u.
    const co = uniqueEmail('coowner');
    const coCtx = await addMemberApi(u.ctx, co, 'OWNER', 'Co Owner');
    await createShopApi(u.ctx, `D2 ${Date.now().toString(36)}`, 'US');
    await createShopApi(u.ctx, `D3 ${Date.now().toString(36)}`, 'US'); // owns 3
    const items = (await (await coCtx.get('/api/staff')).json()).items as {
      id: string;
      email: string;
    }[];
    const row = items.find((i) => i.email === u.email)!;
    expect(
      (
        await coCtx.post(`/api/staff/${row.id}/deactivate`, { headers: jsonHeaders, data: {} })
      ).status(),
    ).toBeLessThan(300);
    const res = await u.ctx.post('/api/shops', {
      headers: jsonHeaders,
      data: { name: 'Allowed again', country: 'GB' },
    });
    expect(res.status(), await res.text()).toBe(201);
  });
});

test.describe('Tenant isolation (PK owner vs US shop)', () => {
  test('ISO-01 guessing US ids from the PK shop never reads or changes US data', async ({
    page,
  }) => {
    const us = await apiAs(SEED.owner);
    const pk = await apiAs(SEED.pkOwner);
    const usStaff = (await (await us.get('/api/staff')).json()).items as {
      id: string;
      kind: string;
      email: string;
      userId: string | null;
    }[];
    const usRates = (await (await us.get('/api/shop/tax-rates')).json()).items as { id: string }[];
    const usEvents = await auditEvents(us);
    const usTech = usStaff.find((s) => s.email === SEED.tech)!;
    const usInvite = usStaff.find((s) => s.kind === 'INVITE')!;
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    const usSheet = await (await us.get(`/api/timesheets?from=${weekAgo}&to=${today}`)).text();
    const usEntryId = /"id":"(seed_te_[^"]+)"/.exec(usSheet)?.[1];
    expect(usEntryId).toBeTruthy();

    const attempts: [string, Promise<import('@playwright/test').APIResponse>][] = [
      ['audit detail', pk.get(`/api/audit-events/${usEvents[0]!.id}`)],
      [
        'edit tax rate',
        pk.patch(`/api/shop/tax-rates/${usRates[0]!.id}`, {
          headers: jsonHeaders,
          data: { name: 'pwned' },
        }),
      ],
      [
        'archive tax rate',
        pk.post(`/api/shop/tax-rates/${usRates[0]!.id}/archive`, {
          headers: jsonHeaders,
          data: {},
        }),
      ],
      [
        'change role',
        pk.patch(`/api/staff/${usTech.id}/role`, {
          headers: jsonHeaders,
          data: { role: 'MANAGER' },
        }),
      ],
      [
        'deactivate',
        pk.post(`/api/staff/${usTech.id}/deactivate`, { headers: jsonHeaders, data: {} }),
      ],
      [
        'revoke invite',
        pk.post(`/api/staff/invites/${usInvite.id}/revoke`, { headers: jsonHeaders, data: {} }),
      ],
      [
        'copy invite link',
        pk.post(`/api/staff/invites/${usInvite.id}/link`, { headers: jsonHeaders, data: {} }),
      ],
      [
        'resend invite',
        pk.post(`/api/staff/invites/${usInvite.id}/resend`, { headers: jsonHeaders, data: {} }),
      ],
      [
        'fix time entry',
        pk.patch(`/api/time-entries/${usEntryId}`, {
          headers: jsonHeaders,
          data: { reason: 'pwned entry', clockInAt: new Date(Date.now() - 3600e3).toISOString() },
        }),
      ],
      [
        'delete time entry',
        pk.delete(`/api/time-entries/${usEntryId}`, {
          headers: jsonHeaders,
          data: { reason: 'pwned entry' },
        }),
      ],
      [
        'add entry for US user',
        pk.post('/api/time-entries', {
          headers: jsonHeaders,
          data: {
            userId: usTech.userId,
            clockInAt: new Date(Date.now() - 7200e3).toISOString(),
            clockOutAt: new Date(Date.now() - 3600e3).toISOString(),
            reason: 'pwned entry',
          },
        }),
      ],
      [
        'switch to US shop',
        pk.post('/api/me/active-shop', { headers: jsonHeaders, data: { shopId: SEED.usShopId } }),
      ],
    ];
    const results: string[] = [];
    for (const [name, p] of attempts) {
      const r = await p;
      results.push(`${name}: ${r.status()}`);
      expect.soft(r.status(), name).toBeGreaterThanOrEqual(400);
      expect.soft(r.status(), name).not.toBe(500);
    }
    test.info().annotations.push({ type: 'isolation statuses', description: results.join('; ') });

    // Reads with a US user filter or a shop header return only PK data.
    const sheet = await (
      await pk.get(`/api/timesheets?from=${weekAgo}&to=${today}&userId=${usTech.userId}`, {
        headers: { 'x-shop-id': SEED.usShopId },
      })
    ).text();
    expect(sheet).not.toContain('seed_te_');
    expect(sheet).not.toContain(SEED.tech);
    // Since Sprint 2 (A13) a mismatching X-Shop-Id is refused outright with 409 ACTIVE_SHOP_CHANGED.
    const wrongHeader = await pk.get('/api/shop', { headers: { 'x-shop-id': SEED.usShopId } });
    expect(wrongHeader.status()).toBe(409);
    expect(JSON.stringify(await wrongHeader.json())).not.toContain(SEED.usShop);
    const pkShop = await (await pk.get('/api/shop')).json();
    expect(pkShop.shop.name).toBe(SEED.pkShop);

    // US data unchanged.
    const after = (await (await us.get('/api/staff')).json()).items as {
      id: string;
      role: string;
      status: string;
    }[];
    expect(after.find((s) => s.id === usTech.id)).toMatchObject({
      role: 'TECHNICIAN',
      status: 'ACTIVE',
    });
    expect((await (await us.get('/api/shop/tax-rates')).json()).items[0].name).toBe('Sales tax');

    // UI: PK owner's settings show only PK data.
    await signInContext(page, SEED.pkOwner);
    await page.goto('/settings/staff');
    await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    await expect(page.getByText(SEED.tech)).toHaveCount(0);
    await page.goto('/settings/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
    await expect(page.getByText('Demo Owner')).toHaveCount(0);
  });
});
