import { expect, test } from '@playwright/test';
import { TOKEN } from './support/fixtures';
import { mockApi } from './support/mock-api';

const INVITE_EMAIL = {
  id: 'mail_2',
  to: 'jo@example.com',
  subject: 'Priya Shah invited you to join Fix It Phones on RepairOS',
  text: `Priya Shah (priya@fixitphones.co.uk) has invited you to join Fix It Phones as Front desk.\n\nAccept invite: http://localhost:3000/invite/${TOKEN}\n\nThis invite expires on 2 December 2026, 09:00.`,
  html: `<p>Priya Shah has invited you to join <strong>Fix It Phones</strong>.</p><p><a href="http://localhost:3000/invite/${TOKEN}">Accept invite</a></p><script>document.title='pwned'</script>`,
  createdAt: '2026-11-25T10:00:00.000Z',
};
const RESET_EMAIL = {
  id: 'mail_1',
  to: 'alex@fixitphones.co.uk',
  subject: 'Reset your RepairOS password',
  text: 'Reset it here: http://localhost:3000/reset-password?token=abc',
  html: '<p>Reset</p>',
  createdAt: '2026-11-24T10:00:00.000Z',
};

test('lists emails, renders one in a sandboxed frame and links into the app', async ({ page }) => {
  await mockApi(page, {
    me: null,
    handlers: {
      'GET /api/dev/outbox': (route) => route.fulfill({ json: { items: [INVITE_EMAIL, RESET_EMAIL] } }),
      'GET /api/dev/outbox/:id': (route, request) =>
        route.fulfill({ json: request.url().endsWith('mail_1') ? RESET_EMAIL : INVITE_EMAIL }),
    },
  });
  await page.goto('/dev/outbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Dev outbox' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: INVITE_EMAIL.subject })).toBeVisible();

  const frame = page.locator(`iframe[title="Email: ${INVITE_EMAIL.subject}"]`);
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(frame.contentFrame().getByText('Fix It Phones')).toBeVisible();
  await expect(page).not.toHaveTitle('pwned');

  await expect(page.getByRole('link', { name: `/invite/${TOKEN}` })).toHaveAttribute('href', `/invite/${TOKEN}`);

  await page.getByText('Reset your RepairOS password').click();
  await expect(page.getByRole('link', { name: '/reset-password?token=abc' })).toBeVisible();
});

test('empty outbox', async ({ page }) => {
  await mockApi(page, {
    me: null,
    handlers: { 'GET /api/dev/outbox': (route) => route.fulfill({ json: { items: [] } }) },
  });
  await page.goto('/dev/outbox');
  await expect(page.getByRole('heading', { name: 'No emails yet' })).toBeVisible();
});
