import { expect, test } from '@playwright/test';
import { ME_WITH_SHOP } from './support/mock-api';
import { mockSprint2 } from './support/sprint2';

/**
 * BUG-03 (docs/qa/sprint2.md): list filters and searches are history entries, so Back undoes them;
 * and the customer-list flake (a pending search commit undoing Clear filters). Failed on main 84df6fb.
 */

// ---------- BUG-03: Back undoes a filter ----------

test('BUG-03 customer list: each filter and each search is one history entry', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/');
  await page.goto('/customers');
  const search = page.getByRole('searchbox', { name: 'Search customers' });
  // Typed with pauses longer than the debounce: still one entry for the one search.
  await search.pressSequentially('al', { delay: 40 });
  await expect(page).toHaveURL(/q=al/);
  await search.pressSequentially('i k', { delay: 40 });
  await expect(page).toHaveURL(/q=ali\+k/);
  await page.getByRole('switch', { name: 'Show archived' }).click();
  await expect(page).toHaveURL(/archived=true/);

  await page.goBack();
  await expect(page).toHaveURL(/\/customers\?q=ali\+k$/);
  await expect(page.getByRole('switch', { name: 'Show archived' })).not.toBeChecked();
  await page.goBack();
  await expect(page).toHaveURL(/\/customers$/);
  await expect(search).toHaveValue('');
  await page.goForward();
  await expect(search).toHaveValue('ali k');
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('BUG-03 ticket list: views, filters and search are history entries', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets');
  const search = page.getByRole('searchbox', { name: 'Search tickets' });
  await search.pressSequentially('sarah', { delay: 30 });
  await expect(page).toHaveURL(/q=sarah/);
  await page
    .getByRole('navigation', { name: 'Ticket views' })
    .getByRole('button', { name: /Overdue/ })
    .click();
  await expect(page).toHaveURL(/view=overdue/);
  await page.goBack();
  await expect(page).toHaveURL(/q=sarah/);
  await expect(page).not.toHaveURL(/view=overdue/);
  await page.goBack();
  await expect(page).not.toHaveURL(/q=/);
  await expect(search).toHaveValue('');
});

test('flake: Clear filters is not undone by a pending search commit', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/customers?archived=true');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('nobody');
  await expect(page).toHaveURL(/q=nobody/);
  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page).toHaveURL(/\/customers$/);
  // A debounced commit captured before Clear used to put archived=true back ~250 ms later.
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/customers$/);
});
