import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { ME_WITH_SHOP } from './support/mock-api';
import { ALI, mockSprint2 } from './support/sprint2';

/** Sprint 2 screens at 1440×900 and 1024×768 → docs/screens/sprint2/*.png (mocked API). */
const OUT_DIR = fileURLToPath(new URL('../../docs/screens/sprint2/', import.meta.url));

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function openCheckIn(page: Page) {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/new');
  await expect(page.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
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

      test('check-in: empty, search results, device list', async ({ page }) => {
        await openCheckIn(page);
        await settle(page);
        await shot(page, 'checkin-empty');
        await page.keyboard.type('ali');
        await expect(page.getByRole('option', { name: /Ali Khan/ })).toBeVisible();
        await settle(page);
        await shot(page, 'checkin-search');
        await page.keyboard.press('Escape');
        await page.getByRole('combobox', { name: 'Find customer' }).fill('');
        await page.keyboard.type('sarah');
        await expect(page.getByRole('option', { name: /Sarah Jones/ })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('radio', { name: /iPhone 15 Pro/ })).toBeFocused();
        await settle(page);
        await shot(page, 'checkin-device-list');
      });

      test('check-in: new customer with a duplicate, new device with a pattern', async ({
        page,
      }) => {
        await openCheckIn(page);
        await page.keyboard.type('Ali Again');
        await page.getByRole('option', { name: /New customer/ }).click();
        await page.getByRole('textbox', { name: 'Phone' }).fill('07400 123456');
        await expect(page.getByText('Already a customer?')).toBeVisible();
        await settle(page);
        await shot(page, 'checkin-new-customer');
        await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900123');
        await expect(page.getByText('Already a customer?')).toBeHidden();
        await page.getByRole('textbox', { name: 'Phone' }).press('Enter');
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

      test('check-in: missing fields, ready to create', async ({ page }) => {
        await openCheckIn(page);
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
      });

      test('tickets list and ticket detail', async ({ page }) => {
        await mockSprint2(page, { me: ME_WITH_SHOP });
        await page.goto('/tickets');
        await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
        await settle(page);
        await shot(page, 'tickets-list');
        await page.goto('/tickets/tkt_1042');
        await expect(page.getByText('Ordered a new screen, arrives tomorrow.')).toBeVisible();
        await settle(page);
        await shot(page, 'ticket-detail');
        await page.getByRole('button', { name: 'Show passcode' }).click();
        await expect(page.getByText('482913')).toBeVisible();
        await page.getByRole('button', { name: 'Change status' }).click();
        await settle(page);
        await shot(page, 'ticket-detail-status-menu');
      });

      test('customers list, detail and form', async ({ page }) => {
        await mockSprint2(page, { me: ME_WITH_SHOP });
        await page.goto('/customers');
        await expect(page.getByRole('link', { name: 'Ali Khan' })).toBeVisible();
        await settle(page);
        await shot(page, 'customers-list');
        await page.goto(`/customers/${ALI.id}`);
        await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
        await settle(page);
        await shot(page, 'customer-detail');
        await page.goto(`/customers/${ALI.id}?tab=details`);
        await expect(page.getByRole('heading', { name: 'Consent history' })).toBeVisible();
        await settle(page);
        await shot(page, 'customer-detail-consent');
        await page.goto('/customers/new');
        await expect(page.getByRole('heading', { level: 1, name: 'New customer' })).toBeVisible();
        await settle(page);
        await shot(page, 'customer-form');
      });

      test('dashboard, search, settings', async ({ page }) => {
        await mockSprint2(page, { me: ME_WITH_SHOP });
        await page.goto('/');
        await expect(page.getByRole('link', { name: 'T-1042' })).toBeVisible();
        await settle(page);
        await shot(page, 'dashboard');
        await page.keyboard.press('ControlOrMeta+k');
        await page.keyboard.type('sarah');
        await expect(page.getByRole('option', { name: /T-1040/ })).toBeVisible();
        await settle(page);
        await shot(page, 'search');
        await page.keyboard.press('Escape');
        await page.goto('/settings/statuses');
        await expect(page.getByRole('button', { name: 'Actions for Received' })).toBeVisible();
        await settle(page);
        await shot(page, 'settings-statuses');
        await page.goto('/settings/tickets');
        await expect(page.getByText('Next ticket: T-1043')).toBeVisible();
        await settle(page);
        await shot(page, 'settings-tickets');
      });
    });
  }
}
