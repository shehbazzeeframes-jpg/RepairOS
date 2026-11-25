import { expect, test, type Page } from '@playwright/test';
import {
  auditEvents,
  jsonHeaders,
  newOwnerShop,
  shot,
  signInContext,
  toast,
} from './support/stack';

type Rate = {
  id: string;
  name: string;
  rateMilliPct: number;
  appliesTo: string;
  isDefaultGoods: boolean;
  isDefaultServices: boolean;
  archivedAt: string | null;
};

async function addRate(page: Page, name: string, rate: string, applies?: RegExp) {
  await page.getByRole('button', { name: 'Add tax rate' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add tax rate' });
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Rate (%)').fill(rate);
  if (applies) {
    await dialog.getByRole('combobox', { name: 'Applies to' }).click();
    await page.getByRole('option', { name: applies }).click();
  }
  await dialog.getByRole('button', { name: 'Add rate' }).click();
  return dialog;
}

test.describe('Tax (TX1, D1, D2)', () => {
  test('TAX-01 add 8.875%, validation, edit, defaults per kind, archive rules, restore, show archived, audit', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Tax');
    const rates = async () =>
      (await (await owner.ctx.get('/api/shop/tax-rates?includeArchived=true')).json())
        .items as Rate[];
    await signInContext(page, owner.email);
    await page.goto('/settings/tax');
    await expect(page.getByRole('heading', { level: 1, name: 'Tax' })).toBeVisible();
    await expect(
      page.getByText('US shops usually add sales tax at checkout', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: '0%' })).toBeVisible(); // US default 0% rate is valid

    // Validation: >3 decimals and >100.
    let dialog = await addRate(page, 'NYC combined', '8.8755');
    await expect(
      dialog.locator('form').getByText('Enter a rate from 0 to 100 with up to 3 decimals'),
    ).toBeVisible();
    await dialog.getByLabel('Rate (%)').fill('100.5');
    await dialog.getByRole('button', { name: 'Add rate' }).click();
    await expect(
      dialog.locator('form').getByText('Enter a rate from 0 to 100 with up to 3 decimals'),
    ).toBeVisible();
    await dialog.getByLabel('Rate (%)').fill('8.875%');
    await dialog.getByRole('combobox', { name: 'Applies to' }).click();
    await page.getByRole('option', { name: /Goods/ }).click();
    await dialog.getByRole('button', { name: 'Add rate' }).click();
    await expect(toast(page, 'NYC combined added')).toBeVisible();
    await expect(
      page.getByRole('row', { name: /NYC combined/ }).getByRole('cell', { name: '8.875%' }),
    ).toBeVisible();
    let nyc = (await rates()).find((r) => r.name === 'NYC combined')!;
    expect(nyc).toMatchObject({ rateMilliPct: 8875, appliesTo: 'goods' });

    // Duplicate name (case-insensitive) among active rates.
    dialog = await addRate(page, 'sales TAX', '1');
    await expect(dialog.getByText(/already|taken|exists/i).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // Edit shows the snapshot note; change rate.
    await page.getByRole('button', { name: 'Actions for NYC combined' }).click();
    await page.getByRole('menuitem', { name: /Edit/ }).click();
    dialog = page.getByRole('dialog').filter({ hasText: 'Changes apply to new sales only' });
    await expect(
      dialog.getByText(
        'Changes apply to new sales only. Past invoices keep the rate they were charged at.',
      ),
    ).toBeVisible();
    await dialog.getByLabel('Rate (%)').fill('8.5');
    await dialog.getByRole('button', { name: /Save/ }).click();
    await expect(
      page.getByRole('row', { name: /NYC combined/ }).getByRole('cell', { name: '8.5%' }),
    ).toBeVisible();

    // Make it the goods default: badge moves, services default stays on "Sales tax".
    await page.getByRole('button', { name: 'Actions for NYC combined' }).click();
    await page.getByRole('menuitem', { name: 'Make goods default' }).click();
    await expect(
      page.getByRole('row', { name: /NYC combined/ }).getByText('Goods default'),
    ).toBeVisible();
    await expect(
      page.getByRole('row', { name: /Sales tax/ }).getByText('Goods default'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('row', { name: /Sales tax/ }).getByText('Services default'),
    ).toBeVisible();
    // A goods rate is never offered as services default, and the API refuses it.
    await page.getByRole('button', { name: 'Actions for NYC combined' }).click();
    await expect(page.getByRole('menuitem', { name: 'Make services default' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    nyc = (await rates()).find((r) => r.name === 'NYC combined')!;
    const wrongKind = await owner.ctx.patch(`/api/shop/tax-rates/${nyc.id}`, {
      headers: jsonHeaders,
      data: { isDefaultServices: true },
    });
    expect(wrongKind.status()).toBeGreaterThanOrEqual(400);

    // Archive a default → TAX_RATE_IS_DEFAULT.
    await page.getByRole('button', { name: 'Actions for NYC combined' }).click();
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(toast(page, 'Choose another default first.')).toBeVisible();

    // Add a services rate, archive it, show archived, restore.
    dialog = await addRate(page, 'Labour', '4.5', /Services/);
    await expect(toast(page, 'Labour added')).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Labour' }).click();
    await expect(page.getByRole('menuitem', { name: 'Make goods default' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Archive…' }).click();
    await expect(
      page
        .getByRole('alertdialog')
        .getByText("It won't be offered for new items or sales. Past records keep it", {
          exact: false,
        }),
    ).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByRole('row', { name: /Labour/ })).toHaveCount(0);
    await page.getByRole('switch', { name: 'Show archived' }).click();
    await expect(page.getByRole('row', { name: /Labour/ }).getByText('Archived')).toBeVisible();
    await page.screenshot({ path: shot('tax-01-archived') });
    await page.getByRole('button', { name: 'Actions for Labour' }).click();
    await page.getByRole('menuitem', { name: /Restore/ }).click();
    await expect(page.getByRole('row', { name: /Labour/ }).getByText('Archived')).toHaveCount(0);

    // Prices include tax toggle with confirm.
    await page.getByRole('switch', { name: 'Prices include tax' }).click();
    await expect(
      page.getByText(
        "This changes how prices are entered and shown from now on. Past sales don't change.",
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Change setting' }).click();
    await expect(toast(page, 'Prices now include tax')).toBeVisible();
    expect((await (await owner.ctx.get('/api/shop')).json()).shop.pricesIncludeTax).toBe(true);

    const actions = (await auditEvents(owner.ctx)).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'tax_rate.created',
        'tax_rate.updated',
        'tax_rate.default_changed',
        'tax_rate.archived',
        'tax_rate.restored',
        'shop.tax_settings_updated',
      ]),
    );
  });

  test('TAX-02 the shop always keeps an active default rate (archive the only rate is refused)', async () => {
    const owner = await newOwnerShop('GB', 'Tax');
    const [only] = (await (await owner.ctx.get('/api/shop/tax-rates')).json()).items as Rate[];
    expect(only).toMatchObject({
      rateMilliPct: 20000,
      isDefaultGoods: true,
      isDefaultServices: true,
    });
    const res = await owner.ctx.post(`/api/shop/tax-rates/${only!.id}/archive`, {
      headers: jsonHeaders,
      data: {},
    });
    expect(res.status()).toBe(409);
    expect(['TAX_RATE_IS_DEFAULT', 'LAST_TAX_RATE']).toContain((await res.json()).code);
  });

  test('TAX-03 PK defaults: GST 18% goods + 16% services; an "All" rate may be default for both', async () => {
    const owner = await newOwnerShop('PK', 'Tax');
    const items = (await (await owner.ctx.get('/api/shop/tax-rates')).json()).items as Rate[];
    expect(
      items.map((r) => [
        r.name,
        r.rateMilliPct,
        r.appliesTo,
        r.isDefaultGoods,
        r.isDefaultServices,
      ]),
    ).toEqual([
      ['GST', 18000, 'goods', true, false],
      ['Sales tax on services', 16000, 'services', false, true],
    ]);
    const created = await owner.ctx.post('/api/shop/tax-rates', {
      headers: jsonHeaders,
      data: {
        name: 'Flat',
        rateMilliPct: 17000,
        appliesTo: 'all',
        isDefaultGoods: true,
        isDefaultServices: true,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const after = (await (await owner.ctx.get('/api/shop/tax-rates')).json()).items as Rate[];
    expect(after.filter((r) => r.isDefaultGoods).map((r) => r.name)).toEqual(['Flat']);
    expect(after.filter((r) => r.isDefaultServices).map((r) => r.name)).toEqual(['Flat']);
  });
});
