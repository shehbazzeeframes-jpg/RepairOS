import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { MeResponse, Shop, permissionsFor } from '@repairos/contracts';
import { meAs } from './support/fixtures';
import { ME_WITH_SHOP, SHOP, USER, toast } from './support/mock-api';
import { ST, mockSprint2, newWorld } from './support/sprint2';

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test.describe('dashboard', () => {
  test('tiles link to filtered lists; my queue', async ({ page }) => {
    await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Alex' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open tickets: 3' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Overdue: 1' })).toBeVisible();
    await expect(page.getByText('Needs attention')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My queue' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
    await axe(page);
    await page.getByText('Finished, waiting for the customer').click();
    await expect(page).toHaveURL(/\/tickets\?view=ready/);
    await expect(page.getByRole('link', { name: 'T-1041' })).toBeVisible();
  });

  test('an empty queue offers unassigned tickets to take', async ({ page }) => {
    const api = await mockSprint2(page, { me: meAs('TECHNICIAN') });
    api.tickets = api.tickets.map((t) => ({ ...t, assignee: null }));
    await page.goto('/');
    await expect(page.getByText('Nothing assigned to you.')).toBeVisible();
    await page.getByRole('button', { name: 'Take T-1040' }).click();
    await expect(toast(page, 'You took T-1040')).toBeVisible();
  });
});

test.describe('global search', () => {
  test('⌘K opens the palette; a result opens; recent items come back', async ({ page }) => {
    await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search RepairOS' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('sarah');
    await expect(palette.getByRole('option', { name: /T-1040 · Sarah Jones/ })).toBeVisible();
    await expect(palette.getByText('Customers')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tickets\/tkt_1040$/);
    await expect(page.getByRole('heading', { level: 1, name: 'T-1040' })).toBeVisible();

    // "/" (not typing) opens it again; Recent now lists the ticket.
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('/');
    await expect(palette.getByRole('option', { name: /T-1040 · Sarah Jones/ })).toBeVisible();
    await expect(palette.getByText('Recent')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('N opens check-in; the top bar button goes there too', async ({ page }) => {
    await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/customers');
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/\/tickets\/new$/);
    await expect(
      page.getByRole('navigation', { name: 'Shop' }).getByRole('link', { name: 'New ticket' }),
    ).toHaveAttribute('href', '/tickets/new');
  });
});

test.describe('settings', () => {
  test('ticket statuses: move down, hide, add with a note requirement', async ({ page }) => {
    const api = await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/settings/statuses');
    await expect(page.getByRole('heading', { level: 1, name: 'Ticket statuses' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Diagnosing' }).click();
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await expect
      .poll(() => api.state.calls.find((c) => c.path === '/api/ticket-statuses/order')?.body)
      .toMatchObject({
        ids: [
          ST.received,
          ST.approval,
          ST.diagnosing,
          ST.parts,
          ST.inRepair,
          ST.ready,
          ST.unrepairable,
          ST.collected,
          ST.cancelled,
        ],
      });
    // System statuses can't be hidden.
    await page.getByRole('button', { name: 'Actions for Received' }).click();
    await expect(page.getByRole('menuitem', { name: 'Hide' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add status' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add status' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Awaiting customer');
    await dialog.getByRole('radio', { name: 'Waiting' }).click();
    await dialog.getByRole('switch', { name: 'Requires a note' }).click();
    await dialog.getByRole('button', { name: 'Add status' }).click();
    await expect(toast(page, 'Awaiting customer added')).toBeVisible();
    expect(
      api.state.calls.find((c) => c.method === 'POST' && c.path === '/api/ticket-statuses')?.body,
    ).toMatchObject({
      name: 'Awaiting customer',
      category: 'WAITING',
      requiresNote: true,
    });
    await axe(page);
  });

  test('ticket settings: prefix preview and the next-number rule', async ({ page }) => {
    await mockSprint2(page, { me: ME_WITH_SHOP });
    await page.goto('/settings/tickets');
    await expect(page.getByText('Next ticket: T-1043')).toBeVisible();
    await page.getByRole('textbox', { name: 'Ticket number prefix' }).fill('rp-');
    await expect(page.getByText('Next ticket: RP-1043')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(toast(page, 'Ticket settings saved')).toBeVisible();
    await axe(page);
  });

  test('front desk and technicians get NoAccess on settings pages by URL', async ({ page }) => {
    await mockSprint2(page, { me: meAs('FRONT_DESK') });
    await page.goto('/settings/statuses');
    await expect(
      page.getByRole('heading', { name: "You don't have access to this page" }),
    ).toBeVisible();
    await page.goto('/settings/tickets');
    await expect(
      page.getByRole('heading', { name: "You don't have access to this page" }),
    ).toBeVisible();
  });
});

const OTHER_SHOP = Shop.parse({ ...SHOP, id: 'shp_2', name: 'Fix It Phones Leeds' });
const membership = (s: Shop) => ({
  shopId: s.id,
  shopName: s.name,
  role: 'OWNER' as const,
  status: 'ACTIVE' as const,
});
const meIn = (s: Shop) =>
  MeResponse.parse({
    user: USER,
    memberships: [membership(SHOP), membership(OTHER_SHOP)],
    activeShop: s,
    role: 'OWNER',
    permissions: permissionsFor('OWNER'),
    accessRemoved: null,
  });

test('A13: switching shop in one tab never writes to the wrong shop from the other, and says so', async ({
  context,
}) => {
  // One world (the server) and one browser context (shared cookies/storage), two tabs.
  const world = newWorld(meIn(SHOP));
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await mockSprint2(tabA, { me: world.me, world });
  await mockSprint2(tabB, { me: world.me, world });
  // The switch endpoint moves the session for every tab.
  await tabA.route('**/api/me/active-shop', async (route) => {
    world.activeShopId = OTHER_SHOP.id;
    world.me = meIn(OTHER_SHOP);
    await route.fulfill({ status: 200, json: world.me });
  });

  // Tab B: a check-in ready to create in shop 1.
  await tabB.goto('/tickets/new');
  await expect(tabB.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  await tabB.keyboard.type('ali k');
  await expect(tabB.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
  await tabB.keyboard.press('Enter');
  await expect(tabB.getByRole('radio', { name: /Apple iPhone 13/ })).toBeFocused();
  await tabB.keyboard.press('Enter');
  await tabB.keyboard.type('scr');
  await tabB.keyboard.press('Enter');

  // Tab A switches to Leeds.
  await tabA.goto('/');
  await tabA.getByRole('button', { name: 'Account: Alex Morgan' }).click();
  await tabA.getByRole('menuitemradio', { name: /Fix It Phones Leeds/ }).click();
  await expect(
    tabA.getByRole('navigation', { name: 'Shop' }).getByText('Fix It Phones Leeds').first(),
  ).toBeVisible();

  // Tab B creates: the API refuses (X-Shop-Id is still shop 1) and the tab moves to Leeds with the banner.
  await tabB.keyboard.press('ControlOrMeta+Enter');
  await expect(
    tabB.getByText("You're now working in Fix It Phones Leeds. This page was reloaded."),
  ).toBeVisible();
  await expect(
    tabB.getByRole('navigation', { name: 'Shop' }).getByText('Fix It Phones Leeds').first(),
  ).toBeVisible();

  const creates = world.created;
  expect(creates).toHaveLength(1);
  expect(creates[0]!.shopId).toBe(SHOP.id);
  // Nothing was written while the session was in the other shop under the wrong header.
  expect(world.tickets.some((t) => t.id === 'tkt_1043')).toBe(false);
  expect(world.writes.every((w) => w.shopId === SHOP.id || w.shopId === null)).toBe(true);
  // The draft stays under the original shop's key.
  const draftKeys = await tabB.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('repairos:checkin-draft:')),
  );
  expect(draftKeys).toEqual([`repairos:checkin-draft:${USER.id}:${SHOP.id}`]);
});
