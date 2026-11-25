import { expect, test } from '@playwright/test';
import { ME_NO_SHOP, ME_WITH_SHOP, SHOP, apiError, mockApi } from './support/mock-api';
import { selectOption } from './support/select';

test('a signed-in user without a shop is sent to onboarding', async ({ page }) => {
  await mockApi(page, { me: ME_NO_SHOP });
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your shop' })).toBeVisible();

  await page.goto('/tickets');
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('onboarding validates, shows market defaults, creates the shop and opens the dashboard', async ({
  page,
}) => {
  const api = await mockApi(page, {
    me: ME_NO_SHOP,
    handlers: {
      'POST /api/shops': async (route) => {
        api.me = ME_WITH_SHOP;
        await route.fulfill({ status: 201, json: SHOP });
      },
    },
  });
  await page.goto('/onboarding');
  const form = page.getByRole('form');

  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(form.getByText('Enter your shop name')).toBeVisible();
  await expect(form.getByText('Select the country your shop is in')).toBeVisible();

  await page.getByLabel('Shop name').fill('Fix It Phones');
  await selectOption(page, 'Country', 'United Kingdom');
  await expect(page.getByText('Prices include VAT 20%')).toBeVisible();
  await expect(page.getByText('GBP · e.g. £129.00')).toBeVisible();

  await selectOption(page, 'Country', 'Pakistan');
  await expect(
    page.getByText('Prices exclude tax: GST 18% on goods, Sales tax on services 16%'),
  ).toBeVisible();
  await expect(page.getByText(/PKR · e\.g\. Rs\s129$/)).toBeVisible();

  await selectOption(page, 'Country', 'United Kingdom');
  await page.getByLabel('Shop phone').fill('020 7123 4567');
  await page.getByLabel('City').fill('London');
  await page.getByRole('button', { name: 'Create shop' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome, Alex' })).toBeVisible();
  const create = api.calls.find((c) => c.path === '/api/shops');
  // Empty optional fields are left out so the API applies its defaults; the contract normalises the phone to E.164.
  expect(create?.body).toEqual({
    name: 'Fix It Phones',
    country: 'GB',
    phone: '+442071234567',
    city: 'London',
  });
});

test('onboarding maps API validation issues onto fields', async ({ page }) => {
  await mockApi(page, {
    me: ME_NO_SHOP,
    handlers: {
      'POST /api/shops': (route) =>
        route.fulfill({
          status: 400,
          json: {
            ...apiError(400, 'VALIDATION_FAILED', 'Check the highlighted fields'),
            issues: [{ path: ['phone'], message: 'Enter a valid phone number for United Kingdom' }],
          },
        }),
    },
  });
  await page.goto('/onboarding');
  const form = page.getByRole('form');
  await page.getByLabel('Shop name').fill('Fix It Phones');
  await selectOption(page, 'Country', 'United Kingdom');
  // Passes the contract's client-side check, so the (mocked) API's issue is what shows.
  await page.getByLabel('Shop phone').fill('020 7123 4567');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('Could not create your shop')).toBeVisible();
  await expect(form.getByText('Enter a valid phone number for United Kingdom')).toBeVisible();
});

test('a user who already has a shop skips onboarding', async ({ page }) => {
  await mockApi(page, { me: ME_WITH_SHOP });
  await page.goto('/onboarding');
  await expect(page).toHaveURL(/\/$/);
});
