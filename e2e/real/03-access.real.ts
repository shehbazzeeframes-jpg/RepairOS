import { expect, test } from '@playwright/test';
import {
  addMemberApi,
  auditEvents,
  createShopApi,
  jsonHeaders,
  newOwnerShop,
  SEED,
  shot,
  signInContext,
  uiSignIn,
  uniqueEmail,
} from './support/stack';

const SETTINGS_PAGES = [
  '/settings',
  '/settings/general',
  '/settings/tax',
  '/settings/hours',
  '/settings/staff',
  '/settings/timesheets',
  '/settings/audit',
];
const NO_ACCESS = "You don't have access to this page";

for (const who of [
  { email: SEED.frontdesk, name: 'Frank Desk' },
  { email: SEED.tech, name: 'Tina Tech' },
]) {
  test(`PERM-01 ${who.name}: no Settings in nav or user menu; every settings URL shows NoAccess; settings APIs 403`, async ({
    page,
  }) => {
    await uiSignIn(page, who.email);
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: `Account: ${who.name}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Clock in is available to every role (timeclock.self).
    await expect(page.getByRole('button', { name: /Clock in|Clocked in/ })).toBeVisible();

    for (const path of SETTINGS_PAGES) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: NO_ACCESS }), path).toBeVisible();
      await expect(page.getByRole('link', { name: 'Back to dashboard' })).toBeVisible();
    }
    await page.screenshot({
      path: shot(`perm-01-${who.name.split(' ')[0]!.toLowerCase()}-noaccess`),
    });

    const from = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    for (const path of [
      '/api/shop',
      '/api/shop/tax-rates',
      '/api/staff',
      `/api/timesheets?from=${from}&to=${to}`,
      `/api/audit-events?from=${from}&to=${to}`,
      `/api/timesheets/export.csv?from=${from}&to=${to}`,
    ]) {
      const res = await page.request.get(path);
      expect.soft(res.status(), path).toBe(403);
      expect.soft((await res.json().catch(() => ({}))).code, path).toBe('FORBIDDEN');
    }
    const patch = await page.request.patch('/api/shop', {
      headers: jsonHeaders,
      data: { name: 'Hacked' },
    });
    expect(patch.status()).toBe(403);
  });
}

test('PERM-02 manager sees all six settings pages', async ({ page }) => {
  await signInContext(page, SEED.manager);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/general$/);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  for (const label of ['General', 'Tax', 'Business hours', 'Staff', 'Timesheets', 'Audit log']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('PERM-03 role change applies on the next request; a demoted manager hitting 403 sees NoAccess after refetch', async ({
  page,
}) => {
  const owner = await newOwnerShop('US', 'Owner');
  const mEmail = uniqueEmail('demoteme');
  await addMemberApi(owner.ctx, mEmail, 'MANAGER', 'Dee Mote');
  await signInContext(page, mEmail);
  await page.goto('/settings/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();

  const items = (await (await owner.ctx.get('/api/staff')).json()).items as {
    id: string;
    email: string;
  }[];
  const row = items.find((i) => i.email === mEmail)!;
  expect(
    (
      await owner.ctx.patch(`/api/staff/${row.id}/role`, {
        headers: jsonHeaders,
        data: { role: 'TECHNICIAN' },
      })
    ).status(),
  ).toBe(200);

  // Next API request uses the new role, without re-login.
  expect((await page.request.get('/api/staff')).status()).toBe(403);
  // The open page: an action that 403s refetches /api/me and the page re-renders as NoAccess.
  await page.getByRole('button', { name: 'Invite staff' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Invite staff' });
  if (await dialog.isVisible()) {
    await dialog.getByLabel('Email').fill(uniqueEmail('x'));
    await dialog.getByRole('button', { name: 'Send invite' }).click();
  }
  await expect(page.getByRole('heading', { name: NO_ACCESS })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
  ).toHaveCount(0);
});

test.describe('Deactivation (S5)', () => {
  test('DEACT-01 deactivated person: next action fails, Access removed page; open entry auto-closed and audited', async ({
    page,
    browser,
  }) => {
    const owner = await newOwnerShop('US', 'Boss');
    const tEmail = uniqueEmail('leaver');
    await addMemberApi(owner.ctx, tEmail, 'TECHNICIAN', 'Lee Leaver');

    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await signInContext(p2, tEmail);
    await p2.goto('/');
    await p2.getByRole('button', { name: 'Clock in' }).click();
    await expect(p2.getByRole('button', { name: /Clocked in/ })).toBeVisible();

    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await expect(
      page.getByRole('row', { name: /Lee Leaver/ }).getByText('Clocked in now'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Lee Leaver' }).click();
    await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText(`Lee Leaver will lose access to ${owner.shop.name} immediately.`, {
        exact: false,
      }),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByRole('row', { name: /Lee Leaver/ })).toHaveCount(0); // default filter hides Deactivated

    // The leaver's very next action (clock out) fails and they land on Access removed.
    await p2.getByRole('button', { name: /Clocked in/ }).click();
    const clockOut = p2.getByRole('menuitem', { name: 'Clock out' });
    if (await clockOut.isVisible().catch(() => false)) await clockOut.click();
    await expect(
      p2.getByRole('heading', {
        level: 1,
        name: `You no longer have access to ${owner.shop.name}`,
      }),
    ).toBeVisible();
    await expect(p2.getByRole('link', { name: 'Create your own shop' })).toBeVisible();
    await expect(p2.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await p2.screenshot({ path: shot('deact-01-access-removed') });

    const tc = await p2.request.get('/api/timeclock/me');
    expect(tc.status()).toBeGreaterThanOrEqual(400);
    const me = await (await p2.request.get('/api/me')).json();
    expect(me.activeShop).toBeNull();
    expect(me.accessRemoved).toBeTruthy();
    // Can't switch back into the shop.
    const sw = await p2.request.post('/api/me/active-shop', {
      headers: jsonHeaders,
      data: { shopId: owner.shop.id },
    });
    expect(sw.status()).toBe(403);

    const actions = (await auditEvents(owner.ctx)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['member.deactivated', 'time_entry.auto_closed']),
    );
    await page.goto('/settings/timesheets');
    await expect(page.getByText('Closed on deactivation').first()).toBeVisible();
    await ctx2.close();
  });

  async function twoShopPerson(page: import('@playwright/test').Page) {
    const owner = await newOwnerShop('GB', 'Boss');
    const email = uniqueEmail('twoshops');
    const person = await addMemberApi(owner.ctx, email, 'FRONT_DESK', 'Tess Twoshop');
    const own = await createShopApi(person, `Tess Own ${Date.now().toString(36)}`, 'US');
    await signInContext(page, email);
    expect(
      (
        await page.request.post('/api/me/active-shop', {
          headers: jsonHeaders,
          data: { shopId: owner.shop.id },
        })
      ).status(),
    ).toBe(200);
    await page.goto('/');
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: owner.shop.name }),
    ).toBeVisible();
    const items = (await (await owner.ctx.get('/api/staff')).json()).items as {
      id: string;
      email: string;
    }[];
    const row = items.find((i) => i.email === email)!;
    expect(
      (
        await owner.ctx.post(`/api/staff/${row.id}/deactivate`, { headers: jsonHeaders, data: {} })
      ).status(),
    ).toBeLessThan(300);
    return { owner, own };
  }

  test('DEACT-02a two-shop person, page (re)loaded after deactivation: other shop + banner', async ({
    page,
  }) => {
    const { owner, own } = await twoShopPerson(page);
    await page.reload();
    await expect(page.getByText(`You no longer have access to ${owner.shop.name}.`)).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: own.name }),
    ).toBeVisible();
    const me = await (await page.request.get('/api/me')).json();
    expect(me.activeShop.id).toBe(own.id);
    expect(me.memberships.map((m: { shopId: string }) => m.shopId)).toEqual([own.id]);
    await page.screenshot({ path: shot('deact-02a-fallback-banner') });
  });

  test('DEACT-02b two-shop person, next in-app action after deactivation (Clock in): other shop + banner', async ({
    page,
  }) => {
    test.fail(
      true,
      'BUG-03: the first /api/me after the 403 carries accessRemoved, a second refetch clears it before the banner renders',
    );
    const { owner, own } = await twoShopPerson(page);
    const meBodies: string[] = [];
    page.on('response', (r) => {
      if (new URL(r.url()).pathname === '/api/me')
        void r
          .text()
          .then((t) => meBodies.push(t))
          .catch(() => undefined);
    });
    await page.getByRole('button', { name: 'Clock in' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: own.name }),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    test
      .info()
      .annotations.push({
        type: '/api/me responses',
        description: meBodies
          .map((b) => /"accessRemoved":(null|\{[^}]*\})/.exec(b)?.[1])
          .join(' | '),
      });
    await page.screenshot({ path: shot('deact-02b-no-banner') });
    await expect(page.getByText(`You no longer have access to ${owner.shop.name}.`)).toBeVisible();
  });

  test('DEACT-03 seeded former@demo.test (only membership deactivated) signs in to Access removed, not onboarding', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(SEED.former);
    await page.getByLabel('Password').fill('Password123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/access-removed$/);
    await expect(
      page.getByRole('heading', { level: 1, name: `You no longer have access to ${SEED.usShop}` }),
    ).toBeVisible();
    await page.goto('/settings/staff');
    await expect(page).toHaveURL(/\/access-removed$/);
    const res = await page.request.get('/api/staff');
    expect([401, 403]).toContain(res.status());
  });

  test('DEACT-04 reactivate restores the same role and re-checks seats', async () => {
    const owner = await newOwnerShop('PK', 'Boss');
    const email = uniqueEmail('comeback');
    await addMemberApi(owner.ctx, email, 'FRONT_DESK', 'Cam Back');
    const items = (await (await owner.ctx.get('/api/staff')).json()).items as {
      id: string;
      email: string;
    }[];
    const row = items.find((i) => i.email === email)!;
    await owner.ctx.post(`/api/staff/${row.id}/deactivate`, { headers: jsonHeaders, data: {} });
    // Fill the 4 free seats (owner = 1 active).
    for (let i = 0; i < 4; i++)
      expect(
        (
          await owner.ctx.post('/api/staff/invites', {
            headers: jsonHeaders,
            data: { email: uniqueEmail(`fill${i}`), role: 'TECHNICIAN' },
          })
        ).status(),
      ).toBe(201);
    const full = await owner.ctx.post(`/api/staff/${row.id}/reactivate`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(full.status()).toBe(403);
    expect((await full.json()).code).toBe('SEAT_LIMIT_REACHED');
    const inv = (
      (await (await owner.ctx.get('/api/staff')).json()).items as { id: string; kind: string }[]
    ).find((i) => i.kind === 'INVITE')!;
    await owner.ctx.post(`/api/staff/invites/${inv.id}/revoke`, { headers: jsonHeaders, data: {} });
    const ok = await owner.ctx.post(`/api/staff/${row.id}/reactivate`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(ok.status()).toBeLessThan(300);
    expect((await ok.json()).role).toBe('FRONT_DESK');
  });
});
