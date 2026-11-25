import { expect, test, type Page } from '@playwright/test';
import {
  auditEvents,
  jsonHeaders,
  newOwnerShop,
  shot,
  signInContext,
  toast,
} from './support/stack';

const form = (page: Page) => page.getByRole('form', { name: 'Shop details' });

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save changes' }).click();
}

test.describe('Shop profile (SP1) with market validation', () => {
  test('PROF-US ZIP, state, phone E.164, time zone confirm, audit of changed fields only', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Prof');
    await signInContext(page, owner.email);
    await page.goto('/settings/general');
    await expect(page.getByLabel('Shop name')).toHaveValue(owner.shop.name);
    await expect(
      page.getByText("Country and currency can't be changed after the shop is created.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByText('United States', { exact: true })).toBeVisible();
    await expect(page.getByText('USD', { exact: false }).first()).toBeVisible();

    await page.getByLabel('ZIP code').fill('1234');
    await page.getByLabel('Shop phone').fill('555');
    await save(page);
    await expect(form(page).getByText('Enter a valid zip code', { exact: false })).toBeVisible();
    await expect(form(page).getByText('Enter a valid phone number')).toBeVisible();

    await page.getByLabel('ZIP code').fill('10001-1234');
    await page.getByLabel('Shop phone').fill('(212) 555-0142');
    await page.getByLabel('City').fill('New York');
    await page.getByRole('button', { name: /^State/ }).click();
    await page.getByRole('option', { name: 'New York' }).click();
    await page.getByRole('combobox', { name: 'Time zone' }).click();
    await page.getByRole('option', { name: /Chicago/ }).click();
    await save(page);
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText(
        /Times on tickets, timesheets and reports will be shown in .*Chicago.*\. Recorded times don't change\./,
      ),
    ).toBeVisible();
    await confirm.getByRole('button', { name: 'Change time zone' }).click();
    await expect(toast(page, 'Shop details saved').last()).toBeVisible();
    await page.screenshot({ path: shot('prof-us-saved') });

    const { shop } = await (await owner.ctx.get('/api/shop')).json();
    expect(shop).toMatchObject({
      phone: '+12125550142',
      postcode: '10001-1234',
      region: 'NY',
      city: 'New York',
      timezone: 'America/Chicago',
    });
    await page.reload();
    await expect(page.getByLabel('Shop phone')).toHaveValue('(212) 555-0142');

    const ev = (await auditEvents(owner.ctx)).find((e) => e.action === 'shop.updated')!;
    expect(ev).toBeTruthy();
    const detail = await (await owner.ctx.get(`/api/audit-events/${ev.id}`)).json();
    test
      .info()
      .annotations.push({
        type: 'shop.updated diff',
        description: JSON.stringify({ before: detail.before, after: detail.after }),
      });
    expect(Object.keys(detail.after ?? {}).sort()).toEqual([
      'city',
      'phone',
      'postcode',
      'region',
      'timezone',
    ]);
    expect(detail.before.timezone).toBe('America/New_York');

    // Country / currency are not editable through the API.
    const bad = await owner.ctx.patch('/api/shop', {
      headers: jsonHeaders,
      data: { country: 'GB', currency: 'GBP' },
    });
    expect(bad.status()).toBe(400);
    expect((await (await owner.ctx.get('/api/shop')).json()).shop.country).toBe('US');
  });

  test('PROF-GB postcode normalised to upper case with a space; UK phone; County free text; single time zone', async ({
    page,
  }) => {
    const owner = await newOwnerShop('GB', 'Prof');
    await signInContext(page, owner.email);
    await page.goto('/settings/general');
    await expect(page.getByLabel('Town/City')).toBeVisible();
    await expect(page.getByText('United Kingdom has one time zone.')).toBeVisible();

    await page.getByLabel('Postcode').fill('nope');
    await save(page);
    await expect(form(page).getByText('Enter a valid postcode')).toBeVisible();

    await page.getByLabel('Postcode').fill('sw1a1aa');
    await page.getByLabel('Shop phone').fill('07911 123456');
    await page.getByLabel('Town/City').fill('London');
    await page.getByLabel('County').fill('Greater London');
    await save(page);
    await expect(toast(page, 'Shop details saved').last()).toBeVisible();
    const { shop } = await (await owner.ctx.get('/api/shop')).json();
    expect(shop).toMatchObject({
      postcode: 'SW1A 1AA',
      phone: '+447911123456',
      region: 'Greater London',
      city: 'London',
    });
    await page.reload();
    await expect(page.getByLabel('Postcode')).toHaveValue('SW1A 1AA');

    // Landline also valid.
    await page.getByLabel('Shop phone').fill('020 7946 0018');
    await save(page);
    await expect(toast(page, 'Shop details saved').last()).toBeVisible();
    expect((await (await owner.ctx.get('/api/shop')).json()).shop.phone).toBe('+442079460018');
  });

  test('PROF-GB-2 the story\'s own UK mobile example "07700 900123" is accepted', async () => {
    test.fail(
      true,
      'BUG-04: 07700 900xxx is an Ofcom drama range that libphonenumber marks invalid; story example and validator disagree',
    );
    const owner = await newOwnerShop('GB', 'Prof');
    const res = await owner.ctx.patch('/api/shop', {
      headers: jsonHeaders,
      data: { phone: '07700 900123' },
    });
    expect(res.status(), await res.text()).toBe(200);
  });

  test('PROF-PK postal code 5 digits, province list, PK mobile and landline', async ({ page }) => {
    const owner = await newOwnerShop('PK', 'Prof');
    await signInContext(page, owner.email);
    await page.goto('/settings/general');
    await page.getByLabel('Postal code').fill('5400');
    await page.getByLabel('Shop phone').fill('12345');
    await save(page);
    await expect(form(page).getByText('Enter a valid postal code')).toBeVisible();
    await expect(form(page).getByText('Enter a valid phone number')).toBeVisible();

    await page.getByLabel('Postal code').fill('54000');
    await page.getByLabel('Shop phone').fill('0300 1234567');
    await page.getByRole('combobox', { name: 'Province' }).click();
    await expect(page.getByRole('option')).toHaveText([
      'Punjab',
      'Sindh',
      'Khyber Pakhtunkhwa',
      'Balochistan',
      'Islamabad Capital Territory',
      'Gilgit-Baltistan',
      'Azad Jammu & Kashmir',
    ]);
    await page.getByRole('option', { name: 'Punjab' }).click();
    await save(page);
    await expect(toast(page, 'Shop details saved').last()).toBeVisible();
    expect((await (await owner.ctx.get('/api/shop')).json()).shop).toMatchObject({
      postcode: '54000',
      phone: '+923001234567',
      region: 'Punjab',
    });

    await page.getByLabel('Shop phone').fill('042 35761234');
    await save(page);
    await expect(toast(page, 'Shop details saved').last()).toBeVisible();
    expect((await (await owner.ctx.get('/api/shop')).json()).shop.phone).toBe('+924235761234');
    await page.screenshot({ path: shot('prof-pk-saved') });
  });

  test('PROF-API server rejects invalid values even without the UI', async () => {
    const owner = await newOwnerShop('US', 'Prof');
    const cases: [Record<string, unknown>, string][] = [
      [{ postcode: 'SW1A 1AA' }, 'postcode'],
      [{ region: 'Punjab' }, 'region'],
      [{ timezone: 'Europe/London' }, 'timezone'],
      [{ phone: '0300 1234567x' }, 'phone'],
      [{ name: 'A' }, 'name'],
    ];
    for (const [data, field] of cases) {
      const res = await owner.ctx.patch('/api/shop', { headers: jsonHeaders, data });
      expect.soft(res.status(), JSON.stringify(data)).toBe(400);
      const body = await res.json().catch(() => ({}));
      expect.soft(JSON.stringify(body.issues ?? []), field).toContain(field);
    }
  });
});
