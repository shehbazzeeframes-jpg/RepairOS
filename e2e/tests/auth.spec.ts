import { expect, test } from '@playwright/test';
import { ME_NO_SHOP, USER, apiError, mockApi } from './support/mock-api';

test.describe('signed out', () => {
  test('redirects protected pages to sign-in', async ({ page }) => {
    await mockApi(page, { me: null });
    await page.goto('/');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    await page.goto('/inventory');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('sign-in shows an error banner when the API rejects the credentials', async ({ page }) => {
    await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/sign-in/email': (route) =>
          route.fulfill({
            status: 401,
            json: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
          }),
      },
    });
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(USER.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Could not sign you in')).toBeVisible();
    await expect(page.getByText('That email and password do not match.')).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('links between sign-in and sign-up', async ({ page }) => {
    await mockApi(page, { me: null });
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page).toHaveURL(/\/sign-up$/);
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe('sign-up form', () => {
  test('validates every field inline before calling the API', async ({ page }) => {
    const api = await mockApi(page, { me: null });
    await page.goto('/sign-up');
    const form = page.getByRole('form');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(form.getByText('Enter your name')).toBeVisible();
    await expect(form.getByText('Enter your email address')).toBeVisible();
    await expect(form.getByText('Use at least 8 characters')).toBeVisible();

    await page.getByLabel('Your name').fill('Alex Morgan');
    await page.getByLabel('Work email').fill('alex@');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(form.getByText('Enter a valid email address')).toBeVisible();
    await expect(form.getByText('Use at least 8 characters')).toBeVisible();
    await expect(form.getByText('Enter your name')).toHaveCount(0);

    expect(api.calls.filter((c) => c.path.startsWith('/api/auth/'))).toHaveLength(0);
  });

  test('shows the API error in a banner', async ({ page }) => {
    await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/sign-up/email': (route) =>
          route.fulfill({
            status: 422,
            json: { code: 'USER_ALREADY_EXISTS', message: 'User already exists' },
          }),
      },
    });
    await page.goto('/sign-up');
    await page.getByLabel('Your name').fill('Alex Morgan');
    await page.getByLabel('Work email').fill(USER.email);
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Could not create your account')).toBeVisible();
    await expect(page.getByText('An account with this email already exists.')).toBeVisible();
  });

  test('creates the account and continues to onboarding', async ({ page }) => {
    const api = await mockApi(page, {
      me: null,
      handlers: {
        'POST /api/auth/sign-up/email': async (route) => {
          api.me = ME_NO_SHOP;
          await route.fulfill({
            status: 200,
            json: {
              token: 'tok',
              user: {
                ...USER,
                emailVerified: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            },
          });
        },
      },
    });
    await page.goto('/sign-up');
    await page.getByLabel('Your name').fill('Alex Morgan');
    await page.getByLabel('Work email').fill(USER.email);
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    const signUp = api.calls.find((c) => c.path === '/api/auth/sign-up/email');
    expect(signUp?.body).toMatchObject({
      name: 'Alex Morgan',
      email: USER.email,
      password: 'correct-horse-battery',
    });
  });
});

test('a 5xx from /api/me shows a retryable error, not the sign-in page', async ({ page }) => {
  let fail = true;
  await mockApi(page, {
    me: null,
    handlers: {
      'GET /api/me': (route) =>
        fail
          ? route.fulfill({
              status: 503,
              json: apiError(503, 'UNAVAILABLE', 'Service unavailable'),
            })
          : route.fulfill({ status: 401, json: apiError(401, 'UNAUTHENTICATED', 'Sign in') }),
    },
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "We couldn't load RepairOS" })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
