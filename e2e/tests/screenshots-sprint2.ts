import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { ME_WITH_SHOP, mockApi } from './support/mock-api';

/** Sprint 2 check-in prototype at 1440×900 and 1024×768 → docs/screens/sprint2/*.png. */
const OUT_DIR = fileURLToPath(new URL('../../docs/screens/sprint2/', import.meta.url));

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function open(page: Page) {
  await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/prototype/check-in');
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
}

export function sprint2Screenshots() {
  for (const viewport of VIEWPORTS) {
    test.describe(`sprint 2 ${viewport.width}x${viewport.height}`, () => {
      test.use({ viewport, deviceScaleFactor: 1 });
      const suffix = `${viewport.width}x${viewport.height}`;
      // The app shell scrolls its content region, not the page, so these are viewport shots;
      // a test scrolls the part it shows into view first.
      const shot = (page: Page, name: string) =>
        page.screenshot({ path: `${OUT_DIR}${name}-${suffix}.png` });

      test('check-in: empty, search results', async ({ page }) => {
        await open(page);
        await settle(page);
        await shot(page, 'checkin-empty');
        await page.keyboard.type('ali');
        await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
        await settle(page);
        await shot(page, 'checkin-search');
      });

      test('check-in: returning customer with note and an open ticket on the device', async ({
        page,
      }) => {
        await open(page);
        await page.keyboard.type('sarah');
        await expect(page.getByRole('option', { name: /Sarah Jones/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('radio', { name: /iPhone 15 Pro/ })).toBeFocused();
        await settle(page);
        await shot(page, 'checkin-device-list');
      });

      test('check-in: new customer and new device with a pattern', async ({ page }) => {
        await open(page);
        await page.keyboard.type('Priya Shah');
        await expect(page.getByRole('option', { name: /New customer/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900123');
        await settle(page);
        await shot(page, 'checkin-new-customer');
        await page.keyboard.press('Enter');
        await page.keyboard.type('pixel 8');
        await page.getByRole('option', { name: 'Google Pixel 8', exact: true }).click();
        await page.getByRole('radio', { name: 'Pattern' }).click();
        await page.getByRole('button', { name: 'Dot 1', exact: true }).focus();
        await page.keyboard.type('1596');
        await page
          .getByText('Lock', { exact: true })
          .evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await settle(page);
        await shot(page, 'checkin-new-device-pattern');
      });

      test('check-in: ready to create, missing fields, created', async ({ page }) => {
        await open(page);
        await page.getByRole('button', { name: 'Create ticket' }).click();
        await expect(page.getByText(/Before creating/)).toBeVisible();
        await settle(page);
        await shot(page, 'checkin-errors');
        await page.keyboard.type('ali k');
        await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('radio', { name: /iPhone 13/ })).toBeFocused();
        await page.keyboard.press('Enter');
        await page.keyboard.type('scr');
        await page.keyboard.press('Enter');
        await page.keyboard.type('batt');
        await page.keyboard.press('Enter');
        await page
          .getByRole('heading', { name: 'Issues' })
          .evaluate((h) => h.scrollIntoView({ block: 'start' }));
        await settle(page);
        await shot(page, 'checkin-ready');
        await page.keyboard.press('ControlOrMeta+Enter');
        await expect(page.getByText('Ticket T-1042 created')).toBeVisible();
        await settle(page);
        await shot(page, 'checkin-created');
      });
    });
  }
}
