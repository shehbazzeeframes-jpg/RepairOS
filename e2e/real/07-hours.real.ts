import { expect, test, type Locator, type Page } from '@playwright/test';
import { auditEvents, newOwnerShop, shot, signInContext, toast } from './support/stack';

type Day = { weekday: number; isOpen: boolean; opensAt: string | null; closesAt: string | null };

/** The row container holding a day's switch (the switch's closest ancestor that also holds the time inputs). */
function dayRow(page: Page, day: string): Locator {
  return page
    .getByRole('switch', { name: `${day} open`, exact: true })
    .locator(`xpath=ancestor::div[count(.//*[@role="switch"])=1][last()]`);
}

async function setTime(box: Locator, value: string) {
  await box.click();
  await box.press('ControlOrMeta+a');
  await box.pressSequentially(value);
  await box.press('Tab');
}

test.describe('Business hours (BH1)', () => {
  test('HRS-01 US: Sunday-first order, 12h display, open Sunday, copy Monday, validation, save, audit', async ({
    page,
  }) => {
    const owner = await newOwnerShop('US', 'Hours');
    await signInContext(page, owner.email);
    await page.goto('/settings/hours');
    const switches = page.getByRole('form', { name: 'Business hours' }).getByRole('switch');
    await expect(switches).toHaveCount(7);
    const names = await switches.evaluateAll((els) =>
      els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? ''),
    );
    test.info().annotations.push({ type: 'switch names', description: names.join(',') });
    await expect(switches.first()).toHaveAccessibleName('Sunday open');
    await expect(switches.last()).toHaveAccessibleName('Saturday open');
    // Defaults D9: Mon–Sat 10–19, Sunday closed.
    await expect(dayRow(page, 'Sunday').getByText('Closed')).toBeVisible();
    await expect(dayRow(page, 'Monday').getByRole('textbox', { name: 'Opens' })).toHaveValue(
      /10:00\s?AM/,
    );
    await expect(dayRow(page, 'Monday').getByRole('textbox', { name: 'Closes' })).toHaveValue(
      /7:00\s?PM/,
    );

    await setTime(dayRow(page, 'Monday').getByRole('textbox', { name: 'Opens' }), '9:00 AM');
    await setTime(dayRow(page, 'Monday').getByRole('textbox', { name: 'Closes' }), '6:00 PM');
    await page.getByRole('button', { name: 'Copy Monday to all weekdays' }).click();
    await expect(dayRow(page, 'Friday').getByRole('textbox', { name: 'Opens' })).toHaveValue(
      /9:00\s?AM/,
    );
    await expect(dayRow(page, 'Saturday').getByRole('textbox', { name: 'Opens' })).toHaveValue(
      /10:00\s?AM/,
    );

    await page.getByRole('switch', { name: 'Sunday open' }).click();
    await expect(dayRow(page, 'Sunday').getByRole('textbox', { name: 'Opens' })).toBeVisible();
    await setTime(dayRow(page, 'Sunday').getByRole('textbox', { name: 'Opens' }), '2:00 PM');
    await setTime(dayRow(page, 'Sunday').getByRole('textbox', { name: 'Closes' }), '11:00 AM');
    await page.getByRole('button', { name: 'Save hours' }).click();
    await expect(
      page
        .getByRole('form', { name: 'Business hours' })
        .getByText('Closing time must be after opening time'),
    ).toBeVisible();
    await setTime(dayRow(page, 'Sunday').getByRole('textbox', { name: 'Closes' }), '5:00 PM');
    await page.getByRole('button', { name: 'Save hours' }).click();
    await expect(toast(page, 'Business hours saved')).toBeVisible();
    await page.screenshot({ path: shot('hrs-01-saved') });

    const hours = (await (await owner.ctx.get('/api/shop')).json()).hours as Day[];
    const by = Object.fromEntries(hours.map((d) => [d.weekday, d]));
    expect(by[0]).toMatchObject({ isOpen: true, opensAt: '14:00', closesAt: '17:00' });
    for (const wd of [1, 2, 3, 4, 5])
      expect(by[wd]).toMatchObject({ isOpen: true, opensAt: '09:00', closesAt: '18:00' });
    expect(by[6]).toMatchObject({ isOpen: true, opensAt: '10:00', closesAt: '19:00' });
    expect((await auditEvents(owner.ctx)).map((e) => e.action)).toContain('shop.hours_updated');
  });

  test('HRS-02 GB: Monday-first order and 24h display; API rejects closes <= opens and non-15-minute steps', async ({
    page,
  }) => {
    const owner = await newOwnerShop('GB', 'Hours');
    await signInContext(page, owner.email);
    await page.goto('/settings/hours');
    const switches = page.getByRole('form', { name: 'Business hours' }).getByRole('switch');
    await expect(switches.first()).toHaveAccessibleName('Monday open');
    await expect(switches.last()).toHaveAccessibleName('Sunday open');
    await expect(dayRow(page, 'Monday').getByRole('textbox', { name: 'Opens' })).toHaveValue(
      '10:00',
    );
    await expect(dayRow(page, 'Monday').getByRole('textbox', { name: 'Closes' })).toHaveValue(
      '19:00',
    );

    const week = (open: string, close: string) =>
      [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        isOpen: weekday !== 0,
        opensAt: weekday ? open : null,
        closesAt: weekday ? close : null,
      }));
    const bad1 = await owner.ctx.put('/api/shop/hours', {
      headers: { 'content-type': 'application/json' },
      data: week('10:00', '09:00'),
    });
    expect(bad1.status()).toBe(400);
    const bad2 = await owner.ctx.put('/api/shop/hours', {
      headers: { 'content-type': 'application/json' },
      data: week('10:07', '18:00'),
    });
    expect(bad2.status()).toBe(400);
  });
});
