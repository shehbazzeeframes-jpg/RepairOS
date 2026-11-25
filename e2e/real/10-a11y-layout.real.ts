import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  inviteApi,
  inviteLinkFrom,
  newOwnerShop,
  SEED,
  shot,
  signInContext,
  uniqueEmail,
  waitForEmail,
} from './support/stack';

/** axe (WCAG 2.0/2.1 A + AA). Violations are soft failures with details in the annotations. */
async function axe(page: Page, label: string) {
  await page.waitForTimeout(700); // let open/enter animations finish (mid-fade text fails colour contrast)
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id} [${v.impact}] x${v.nodes.length}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
  if (summary.length)
    test.info().annotations.push({ type: `axe ${label}`, description: summary.join('\n') });
  expect.soft(summary, `axe violations on ${label}`).toEqual([]);
}

async function noHorizontalScroll(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect
    .soft(scrollWidth, `${label}: page scrolls horizontally (${scrollWidth} > ${clientWidth})`)
    .toBeLessThanOrEqual(clientWidth);
}

const SETTINGS = [
  { path: '/settings/general', h1: 'General' },
  { path: '/settings/tax', h1: 'Tax' },
  { path: '/settings/hours', h1: 'Business hours' },
  { path: '/settings/staff', h1: 'Staff' },
  { path: '/settings/timesheets', h1: 'Timesheets' },
  { path: '/settings/audit', h1: 'Audit log' },
];

test.describe('Accessibility (axe) and layout at 1024 / 1440', () => {
  for (const width of [1024, 1440]) {
    test(`A11Y-settings-${width} settings pages: axe clean, one h1, labelled nav, no horizontal scroll`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInContext(page, SEED.owner);
      for (const { path, h1 } of SETTINGS) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
        await page.waitForTimeout(800);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        // At 1024 the settings nav is still the side panel (TabList only at <= 900px).
        await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
        await noHorizontalScroll(page, `${path}@${width}`);
        await page.screenshot({
          path: shot(`layout-${width}-${path.split('/').pop()}`),
          fullPage: false,
        });
        if (width === 1440) await axe(page, path);
      }
    });
  }

  test('LAYOUT-1024 staff table: own name and the "You" badge are readable at 1024px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await signInContext(page, SEED.owner);
    await page.goto('/settings/staff');
    const nameCell = page
      .getByRole('row', { name: /owner@demo\.test/ })
      .getByRole('cell')
      .first();
    await expect(nameCell).toBeVisible();
    const truncated = await nameCell.evaluate((cell) =>
      [cell, ...Array.from(cell.querySelectorAll('*'))]
        .filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1)
        .map((e) => e.textContent),
    );
    test.info().annotations.push({ type: 'truncated', description: JSON.stringify(truncated) });
    expect(truncated).toEqual([]);
  });

  test('A11Y-dialogs invite dialog, audit drawer and My hours dialog', async ({ page }) => {
    await signInContext(page, SEED.manager);
    await page.goto('/settings/staff');
    await page.waitForTimeout(800);
    // Seed shop is full, so the Invite button is disabled for owner and manager alike: use a fresh shop for the dialog.
    const owner = await newOwnerShop('US', 'A11y');
    await signInContext(page, owner.email);
    await page.goto('/settings/staff');
    await page.getByRole('button', { name: 'Invite staff' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Invite staff' })).toBeVisible();
    await axe(page, 'invite dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Invite staff' })).toHaveCount(0);

    await page.goto('/settings/audit');
    await page.getByRole('link', { name: 'Created shop' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Audit event' })).toBeVisible();
    await axe(page, 'audit drawer');
    await page.keyboard.press('Escape');

    await page.goto('/');
    await page.getByRole('button', { name: 'Time clock options' }).click();
    await page.getByRole('menuitem', { name: 'My hours' }).click();
    await expect(page.getByRole('dialog', { name: 'My hours' })).toBeVisible();
    await axe(page, 'my hours dialog');
  });

  test('A11Y-public invite, sign-up with invite, forgot/reset password, access removed, dev outbox', async ({
    page,
    browser,
  }) => {
    const owner = await newOwnerShop('GB', 'A11y');
    const invitee = uniqueEmail('a11y');
    await inviteApi(owner.ctx, invitee, 'TECHNICIAN');
    const link = inviteLinkFrom(await waitForEmail(invitee, /invited you to join/));
    const pages: [string, string][] = [
      [new URL(link).pathname, `Join ${owner.shop.name}`],
      [`/sign-up?invite=${link.split('/invite/')[1]}`, ''],
      ['/forgot-password', ''],
      ['/reset-password?token=abc', ''],
      ['/invite/not-a-token', ''],
    ];
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, h1] of pages) {
        await page.goto(path);
        if (h1) await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
        await page.waitForTimeout(800);
        await noHorizontalScroll(page, `${path}@${width}`);
        if (width === 1440) await axe(page, path.split('?')[0]!);
      }
    }
    const ctx = await browser.newContext();
    const p2 = await ctx.newPage();
    await signInContext(p2, SEED.former);
    await p2.goto('/access-removed');
    await expect(p2.getByRole('heading', { level: 1 })).toBeVisible();
    await axe(p2, '/access-removed');
    await p2.goto('/dev/outbox');
    await expect(p2.getByRole('heading', { level: 1, name: 'Dev outbox' })).toBeVisible();
    // axe is not run on /dev/outbox: it renders each email in a sandboxed srcdoc iframe (no scripts), which axe cannot
    // enter, and the page is dev-only (404 in production).
    await ctx.close();
  });
});
