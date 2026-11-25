import { expect, test } from '@playwright/test';
import { ME_WITH_SHOP } from './support/mock-api';
import { ALI, mockSprint2 } from './support/sprint2';

/**
 * BUG-01 / BUG-04 (docs/qa/sprint2.md): phone and IMEI are validated when leaving the field.
 * Failed on main 84df6fb.
 */

// ---------- BUG-01: phone validated on blur ----------

test('BUG-01 check-in: an invalid phone is flagged on blur and blocks “Use this customer”', async ({
  page,
}) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/new');
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Find customer' }).fill('Bad Phone');
  await page.getByRole('option', { name: /New customer “Bad Phone”/ }).click();
  const phone = page.getByRole('textbox', { name: 'Phone' });
  await phone.fill('020 1234');
  await phone.press('Tab');
  await expect(page.getByText('Enter a valid phone number').first()).toBeVisible();

  // The Customer section stays open (not "Done"), with focus back on the phone.
  await page.getByRole('button', { name: 'Use this customer' }).click();
  await expect(phone).toBeFocused();
  await expect(page.getByRole('button', { name: 'Change customer' })).toHaveCount(0);
  await phone.press('Enter');
  await expect(phone).toBeFocused();
  await expect(page.getByRole('button', { name: 'Use this customer' })).toBeVisible();

  await phone.fill('07400 900123');
  await phone.press('Enter');
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
});

test('BUG-01 customer form: an invalid phone is flagged on blur', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/customers/new');
  await page.getByRole('textbox', { name: 'First name' }).fill('Dana');
  const phone = page.getByRole('textbox', { name: 'Phone', exact: true });
  await phone.fill('020 1234');
  await phone.press('Tab');
  await expect(page.getByText('Enter a valid phone number').first()).toBeVisible();
  await phone.fill('07400 900123');
  await phone.press('Tab');
  await expect(page.getByText('Enter a valid phone number')).toHaveCount(0);
});

// ---------- BUG-04: IMEI validated on blur ----------

test('BUG-04 device dialog: a 14-digit IMEI is flagged on blur', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}?tab=devices`);
  await page.getByRole('button', { name: 'Add device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add device' });
  await dialog.getByRole('textbox', { name: 'IMEI' }).fill('35693803564380');
  await dialog.getByRole('textbox', { name: 'IMEI' }).press('Tab');
  await expect(dialog.getByText(/This IMEI isn't valid.*15 digits/).first()).toBeVisible();
});

test('BUG-04 check-in: a 14-digit IMEI is flagged on blur', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/new');
  await expect(page.getByRole('button', { name: 'Create ticket' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Find customer' }).fill('Priya Shah');
  await page.getByRole('option', { name: /New customer “Priya Shah”/ }).click();
  await page.getByRole('textbox', { name: 'Phone' }).fill('07400 900123');
  await page.getByRole('textbox', { name: 'Phone' }).press('Enter');
  await page.getByRole('combobox', { name: 'Model' }).fill('iph 13');
  await page.getByRole('option').first().click();
  const imei = page.getByRole('textbox', { name: 'IMEI' });
  await imei.fill('35693803564380');
  await expect(page.getByText(/This IMEI isn't valid/)).toHaveCount(0);
  await imei.press('Tab');
  await expect(page.getByText(/This IMEI isn't valid.*15 digits/).first()).toBeVisible();
});
