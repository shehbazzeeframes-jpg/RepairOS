import { expect, test } from '@playwright/test';
import { AcceptInviteResponse, InvitePreview, MeResponse } from '@repairos/contracts';
import {
  INVITE_EXPIRED,
  INVITE_VALID,
  JO,
  NOW,
  TOKEN,
  TOKEN_EXPIRED,
  meAs,
} from './support/fixtures';
import { ME_NO_SHOP, SHOP, apiError, mockApi, toast } from './support/mock-api';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

const preview = (body: InvitePreview) => (route: import('@playwright/test').Route) =>
  route.fulfill({ json: body });

const JO_NO_SHOP = MeResponse.parse({ ...ME_NO_SHOP, user: JO });

test.describe('forgot / reset password', () => {
  test('sign-in links to forgot password, which always gives the same answer', async ({ page }) => {
    const api = await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/request-password-reset': (route) =>
          route.fulfill({ json: { status: true } }),
      },
    });
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(page.getByText(/If an account exists for/)).toBeVisible();
    const call = api.calls.find((c) => c.path === '/api/auth/request-password-reset');
    expect(call?.body).toMatchObject({ email: 'nobody@example.com' });
    expect((call?.body as { redirectTo: string }).redirectTo).toMatch(/\/reset-password$/);
  });

  test('resets the password with a valid token', async ({ page }) => {
    const api = await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/reset-password': (route) => route.fulfill({ json: { status: true } }),
      },
    });
    await page.goto('/reset-password?token=reset123');
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('form').getByText('Use at least 8 characters')).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill('correct-horse-battery');
    await page.getByLabel('Confirm new password').fill('correct-horse-batter');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('form').getByText("Passwords don't match")).toBeVisible();
    await page.getByLabel('Confirm new password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible();
    expect(api.calls.find((c) => c.path === '/api/auth/reset-password')?.body).toEqual({
      newPassword: 'correct-horse-battery',
      token: 'reset123',
    });
  });

  test('an expired or used token offers a new link', async ({ page }) => {
    await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/reset-password': (route) =>
          route.fulfill({ status: 400, json: { code: 'INVALID_TOKEN', message: 'invalid token' } }),
      },
    });
    await page.goto('/reset-password?error=INVALID_TOKEN');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();

    await page.goto('/reset-password?token=old');
    await page.getByLabel('New password', { exact: true }).fill('correct-horse-battery');
    await page.getByLabel('Confirm new password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});

test.describe('invite', () => {
  test('signed out: create an account with the invite email locked, return, join, land on the dashboard', async ({
    page,
  }) => {
    const api = await mockApi(page, {
      me: null,
      handlers: {
        [`GET /api/invites/${TOKEN}`]: preview(INVITE_VALID),
        'POST /api/auth/sign-up/email': async (route) => {
          api.me = JO_NO_SHOP;
          await route.fulfill({ json: { token: 't', user: { ...JO, emailVerified: false } } });
        },
        [`POST /api/invites/${TOKEN}/accept`]: async (route) => {
          api.me = meAs('FRONT_DESK', { user: JO });
          await route.fulfill({
            json: AcceptInviteResponse.parse({
              shopId: SHOP.id,
              shopName: SHOP.name,
              role: 'FRONT_DESK',
              alreadyMember: false,
            }),
          });
        },
      },
    });
    await page.goto(`/invite/${TOKEN}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Join Fix It Phones' })).toBeVisible();
    await expect(page.getByText('Priya Shah invited you to join')).toBeVisible();
    await page.getByRole('link', { name: 'Create account' }).click();

    await expect(page).toHaveURL(new RegExp(`/sign-up\\?invite=${TOKEN}$`));
    await expect(page.getByText('Joining Fix It Phones.', { exact: false })).toBeVisible();
    const email = page.getByLabel('Work email');
    await expect(email).toHaveValue('jo@example.com');
    await expect(email).toHaveAttribute('readonly', '');
    await page.getByLabel('Your name').fill('Jo Bloggs');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Back on the invite (not onboarding), signed in as the invited email.
    await expect(page).toHaveURL(new RegExp(`/invite/${TOKEN}$`));
    await page.getByRole('button', { name: 'Join Fix It Phones' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(toast(page, 'Welcome to Fix It Phones')).toBeVisible();
    expect(api.calls.find((c) => c.path === '/api/auth/sign-up/email')?.body).toMatchObject({
      email: 'jo@example.com',
    });
  });

  test('"I already have an account" prefills sign-in and returns to the invite', async ({
    page,
  }) => {
    const api = await mockApi(page, {
      me: null,
      handlers: {
        [`GET /api/invites/${TOKEN}`]: preview(INVITE_VALID),
        'POST /api/auth/sign-in/email': async (route) => {
          api.me = JO_NO_SHOP;
          await route.fulfill({ json: { token: 't', user: { ...JO, emailVerified: true } } });
        },
      },
    });
    await page.goto(`/invite/${TOKEN}`);
    await page.getByRole('link', { name: 'I already have an account' }).click();
    await expect(page.getByLabel('Email')).toHaveValue('jo@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/invite/${TOKEN}$`));
    await expect(page.getByRole('button', { name: 'Join Fix It Phones' })).toBeVisible();
  });

  test('a signed-in user with no shop is not sent to onboarding from an invite', async ({
    page,
  }) => {
    await mockApi(page, {
      me: JO_NO_SHOP,
      handlers: { [`GET /api/invites/${TOKEN}`]: preview(INVITE_VALID) },
    });
    await page.goto(`/invite/${TOKEN}`);
    await expect(page.getByRole('button', { name: 'Join Fix It Phones' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/invite/${TOKEN}$`));
  });

  test('wrong account: explains the mismatch and offers sign out', async ({ page }) => {
    const api = await mockApi(page, {
      me: ME_NO_SHOP,
      handlers: { [`GET /api/invites/${TOKEN}`]: preview(INVITE_VALID) },
    });
    await page.goto(`/invite/${TOKEN}`);
    await expect(
      page.getByText(
        "This invite is for jo@example.com, but you're signed in as alex@fixitphones.co.uk.",
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Join Fix It Phones' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out and continue' }).click();
    await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/invite/${TOKEN}$`));
    expect(api.calls.some((c) => c.path === '/api/auth/sign-out')).toBe(true);
  });

  test('the API email mismatch on accept shows the same explanation', async ({ page }) => {
    await mockApi(page, {
      me: JO_NO_SHOP,
      handlers: {
        [`GET /api/invites/${TOKEN}`]: preview(INVITE_VALID),
        [`POST /api/invites/${TOKEN}/accept`]: (route) =>
          route.fulfill({ status: 403, json: apiError(403, 'INVITE_EMAIL_MISMATCH', 'Mismatch') }),
      },
    });
    await page.goto(`/invite/${TOKEN}`);
    await page.getByRole('button', { name: 'Join Fix It Phones' }).click();
    await expect(page.getByRole('button', { name: 'Sign out and continue' })).toBeVisible();
  });

  test('expired invite', async ({ page }) => {
    await mockApi(page, {
      me: null,
      handlers: { [`GET /api/invites/${TOKEN_EXPIRED}`]: preview(INVITE_EXPIRED) },
    });
    await page.goto(`/invite/${TOKEN_EXPIRED}`);
    await expect(page.getByRole('heading', { name: 'Invite expired' })).toBeVisible();
    await expect(
      page.getByText(
        /This invite expired on November 10, 2026\. Ask Priya Shah to send a new one\./,
      ),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Join/ })).toHaveCount(0);
  });

  test('revoked, already joined and invalid links', async ({ page }) => {
    let state: InvitePreview | null = InvitePreview.parse({ state: 'REVOKED' });
    await mockApi(page, {
      me: meAs('FRONT_DESK'),
      handlers: {
        [`GET /api/invites/${TOKEN}`]: (route) =>
          state
            ? route.fulfill({ json: state })
            : route.fulfill({ status: 404, json: apiError(404, 'INVITE_INVALID', 'Invalid') }),
      },
    });
    await page.goto(`/invite/${TOKEN}`);
    await expect(
      page.getByText('This invite is no longer valid. Ask the shop for a new invite.'),
    ).toBeVisible();

    state = InvitePreview.parse({ state: 'ACCEPTED', shopId: SHOP.id, shopName: SHOP.name });
    await page.reload();
    await expect(page.getByText("You've already joined Fix It Phones.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Fix It Phones' })).toBeVisible();

    state = null;
    await page.reload();
    await expect(page.getByText("This invite link isn't valid.")).toBeVisible();

    await page.goto('/invite/not-a-real-token');
    await expect(page.getByText("This invite link isn't valid.")).toBeVisible();
  });
});
