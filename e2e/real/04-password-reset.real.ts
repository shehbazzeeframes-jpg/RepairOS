import { expect, test } from '@playwright/test';
import { resetLinkFrom, shot, signUpApi, uniqueEmail, waitForEmail } from './support/stack';

test.describe('Forgot / reset password (D4)', () => {
  test('PWD-01 request a reset, use the outbox link, sign in with the new password; the link is single-use', async ({
    page,
  }) => {
    const email = uniqueEmail('forgetful');
    await signUpApi('Fay Forgetful', email);

    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(
      page.getByText(`If an account exists for ${email}`, { exact: false }),
    ).toBeVisible();

    const mail = await waitForEmail(email, /password/i);
    const link = resetLinkFrom(mail);
    test.info().annotations.push({ type: 'reset subject', description: mail.subject });
    expect(link).toContain('http://localhost:3200/');

    // Follow it via the dev outbox page, like a developer would.
    await page.goto('/dev/outbox');
    await page.getByText(mail.subject).first().click();
    await page
      .getByRole('link', { name: /reset-password/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    const resetUrl = page.url();
    await page.getByLabel('New password', { exact: true }).fill('BrandNew456!');
    await page.getByLabel('Confirm new password').fill('BrandNew456!');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
    await page.screenshot({ path: shot('pwd-01-updated') });

    // Old password fails, new one works.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('Password123!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('That email and password do not match.')).toBeVisible();
    await page.getByLabel('Password').fill('BrandNew456!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/onboarding$/);

    // Re-using the link fails with the expired state.
    await page.context().clearCookies();
    await page.goto(resetUrl);
    await page.getByLabel('New password', { exact: true }).fill('Another789!');
    await page.getByLabel('Confirm new password').fill('Another789!');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
  });

  test('PWD-02 unknown email gets the same answer and sends nothing', async ({ page }) => {
    const ghost = uniqueEmail('ghost');
    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(ghost);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await page.waitForTimeout(2000);
    const { items } = (await (await page.request.get('/api/dev/outbox')).json()) as {
      items: { to: string }[];
    };
    expect(items.some((i) => i.to === ghost)).toBe(false);
  });
});
