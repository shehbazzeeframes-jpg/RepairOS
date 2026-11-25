import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  inviteApi,
  inviteLinkFrom,
  newOwnerShop,
  resetLinkFrom,
  signInContext,
  signUpApi,
  uniqueEmail,
  waitForEmail,
} from './support/stack';

/**
 * SEC-01 needs the API's stdout log: start the API with `> $REAL_API_LOG` and export REAL_API_LOG for the run.
 * Skipped when REAL_API_LOG is unset.
 */
test('SEC-01 invite and password-reset tokens never reach the API logs (E1.5, Risk #2)', async ({
  page,
}) => {
  const logPath = process.env.REAL_API_LOG;
  test.skip(
    !logPath || !existsSync(logPath),
    'Set REAL_API_LOG to the API log file to run this check',
  );
  // Invite: open the link and accept it through the browser.
  const owner = await newOwnerShop('US', 'Sec');
  const invitee = uniqueEmail('sec');
  await inviteApi(owner.ctx, invitee, 'TECHNICIAN');
  const link = inviteLinkFrom(await waitForEmail(invitee, /invited you to join/));
  await signUpApi('Sec Person', invitee);
  await signInContext(page, invitee);
  await page.goto(link);
  await page.getByRole('button', { name: `Join ${owner.shop.name}` }).click();
  await expect(page).toHaveURL(/\/$/);

  // Password reset: open the reset page (any API call from it carries the Referer).
  const email = uniqueEmail('secreset');
  await signUpApi('Sec Reset', email);
  await page.request.post('/api/auth/request-password-reset', {
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3200' },
    data: { email, redirectTo: 'http://localhost:3200/reset-password' },
  });
  const reset = resetLinkFrom(await waitForEmail(email, /password/i));
  await page.context().clearCookies();
  await page.goto(reset);
  await page.getByLabel('New password', { exact: true }).fill('Changed123!');
  await page.getByLabel('Confirm new password').fill('Changed123!');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
  await page.waitForTimeout(1000);

  const log = readFileSync(logPath!, 'utf8');
  const inviteToken = link.split('/invite/')[1]!;
  const resetToken =
    new URL(reset).searchParams.get('token') ?? reset.split('/reset-password/')[1]!;
  expect.soft(log.includes(inviteToken), 'invite token in API log').toBe(false);
  expect.soft(log.includes(resetToken), 'reset token in API log').toBe(false);
});

test('A11Y-names-hours each weekday time input has a day-specific accessible name', async ({
  page,
}) => {
  const owner = await newOwnerShop('GB', 'Names');
  await signInContext(page, owner.email);
  await page.goto('/settings/hours');
  await expect(page.getByRole('switch', { name: 'Monday open' })).toBeVisible();
  const opens = await page.getByRole('textbox', { name: 'Opens', exact: true }).count();
  test
    .info()
    .annotations.push({ type: 'inputs named exactly "Opens"', description: String(opens) });
  expect(opens).toBe(0);
});

test('A11Y-names-clock the clocked-in button is named "Clocked in {elapsed}" once', async ({
  page,
}) => {
  const owner = await newOwnerShop('GB', 'Names');
  await signInContext(page, owner.email);
  await page.goto('/');
  await page.getByRole('button', { name: 'Clock in' }).click();
  const clock = page.getByRole('button', { name: /Clocked in \d+m$/ });
  await expect(clock).toBeVisible();
  await expect(clock).toHaveAccessibleName(/^Clocked in \d+m$/, { timeout: 3000 });
});
