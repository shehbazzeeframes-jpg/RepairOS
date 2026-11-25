import { expect, test } from '@playwright/test';
import { ME_WITH_SHOP, SHOP, mockApi } from './support/mock-api';

const NAV = ['Dashboard', 'Tickets', 'Customers', 'POS', 'Inventory', 'Reports', 'Settings'];

test('renders the shell for a user with a shop', async ({ page }) => {
  await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Alex' })).toBeVisible();
  const topNav = page.getByRole('navigation', { name: 'Shop' });
  await expect(topNav.getByText(SHOP.name)).toBeVisible();
  await expect(page.getByPlaceholder('Search tickets, customers, IMEI…')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New ticket' }).first()).toBeVisible();

  const sideNav = page.getByRole('navigation', { name: 'Main' });
  for (const label of NAV) await expect(sideNav.getByRole('link', { name: label })).toBeVisible();
  await expect(sideNav.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  for (const label of ['Open tickets', 'Ready for pickup', "Today's sales"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('£0.00')).toBeVisible();
});

test('nav placeholders say which sprint delivers them', async ({ page }) => {
  await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/');
  const sideNav = page.getByRole('navigation', { name: 'Main' });
  const expected: [string, number][] = [
    ['Tickets', 2],
    ['Customers', 2],
    ['Inventory', 4],
    ['POS', 5],
    ['Reports', 6],
    ['Settings', 1],
  ];
  for (const [label, sprint] of expected) {
    await sideNav.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
    await expect(page.getByRole('heading', { name: `Coming in Sprint ${sprint}` })).toBeVisible();
    await expect(sideNav.getByRole('link', { name: label })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});

test('user menu shows name and role and signs out', async ({ page }) => {
  const api = await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account: Alex Morgan' }).click();
  await expect(page.getByText('Owner · alex@fixitphones.co.uk')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(api.calls.some((c) => c.path === '/api/auth/sign-out')).toBe(true);
});

test.describe('tablet width (1024px)', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('sidebar starts collapsed and can be expanded', async ({ page }) => {
    await mockApi(page, { me: ME_WITH_SHOP });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Alex' })).toBeVisible();

    const expand = page.getByRole('button', { name: 'Expand sidebar' });
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByText('Back office'),
    ).toBeVisible();

    // Nothing in the page overflows horizontally at tablet width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
