import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { sprint1Screenshots } from './screenshots-sprint1';
import { sprint2Screenshots } from './screenshots-sprint2';
import { selectOption } from './support/select';
import { ME_NO_SHOP, ME_WITH_SHOP, mockApi } from './support/mock-api';

/** Run with `pnpm --filter @repairos/e2e screenshots`; writes docs/screens/sprint0/*.png, sprint1/*.png and sprint2/*.png. */
const OUT_DIR = fileURLToPath(new URL('../../docs/screens/sprint0/', import.meta.url));

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  // Let entrance transitions finish.
  await page.waitForTimeout(400);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, deviceScaleFactor: 1 });
    const suffix = `${viewport.width}x${viewport.height}`;

    test('sign-in', async ({ page }) => {
      await mockApi(page, { me: null });
      await page.goto('/sign-in');
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await settle(page);
      await page.screenshot({ path: `${OUT_DIR}sign-in-${suffix}.png`, fullPage: true });
    });

    test('onboarding', async ({ page }) => {
      await mockApi(page, { me: ME_NO_SHOP });
      await page.goto('/onboarding');
      await page.getByLabel('Shop name').fill('Fix It Phones');
      await selectOption(page, 'Country', 'United Kingdom');
      await expect(page.getByText('Prices include VAT 20%')).toBeVisible();
      await page.getByLabel('Shop name').focus();
      await page.getByLabel('Shop name').blur();
      await settle(page);
      await page.screenshot({ path: `${OUT_DIR}onboarding-${suffix}.png`, fullPage: true });
    });

    test('dashboard', async ({ page }) => {
      await mockApi(page, { me: ME_WITH_SHOP });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Alex' })).toBeVisible();
      await settle(page);
      await page.screenshot({ path: `${OUT_DIR}dashboard-${suffix}.png` });
    });
  });
}

sprint1Screenshots();
sprint2Screenshots();
