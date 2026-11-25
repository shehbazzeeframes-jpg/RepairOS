import { expect, test, type Browser, type Page } from '@playwright/test';
import { ME_WITH_SHOP, toast } from './support/mock-api';
import { ALI, mockSprint2, newWorld, type FakeApi } from './support/sprint2';

/**
 * BUG-02 (docs/qa/sprint2.md): Reload after a version conflict must not save stale copies of fields
 * the person never touched. Failed on main 84df6fb.
 */

async function twoTabs(browser: Browser, world: FakeApi): Promise<[Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    // Two contexts: two people (or two machines) on the same shop.
    const context = await browser.newContext();
    const page = await context.newPage();
    await mockSprint2(page, { me: world.me, world });
    pages.push(page);
  }
  return pages as [Page, Page];
}

const patches = (world: FakeApi, path: string) =>
  world.writes.filter((w) => w.method === 'PATCH' && w.path === path).length;

// ---------- BUG-02: lost update after a version conflict ----------

test('BUG-02 ticket: Reload after a conflict takes the colleague’s change and saves only mine', async ({
  browser,
}) => {
  const world = newWorld(ME_WITH_SHOP);
  const [a, b] = await twoTabs(browser, world);
  const sent: unknown[] = [];
  b.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith('/api/tickets/tkt_1039'))
      sent.push(r.postDataJSON());
  });

  // B opens Edit details first, then A saves a condition note.
  await b.goto('/tickets/tkt_1039');
  await b.getByRole('button', { name: 'Edit details' }).first().click();
  const dialogB = b.getByRole('dialog', { name: 'Edit T-1039' });
  await expect(dialogB.getByRole('textbox', { name: 'Condition notes' })).toHaveValue('');

  await a.goto('/tickets/tkt_1039');
  await a.getByRole('button', { name: 'Edit details' }).first().click();
  const dialogA = a.getByRole('dialog', { name: 'Edit T-1039' });
  await dialogA.getByRole('textbox', { name: 'Condition notes' }).fill('Scratch on the back');
  await dialogA.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(a, 'Ticket saved')).toBeVisible();

  // B ticks Urgent and saves: conflict, Reload, save again.
  await dialogB.getByRole('radio', { name: 'Urgent' }).click();
  await dialogB.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialogB.getByText(/This ticket was changed by/)).toBeVisible();
  await dialogB.getByRole('button', { name: 'Reload' }).click();
  await expect(dialogB.getByRole('textbox', { name: 'Condition notes' })).toHaveValue(
    'Scratch on the back',
  );
  await expect(dialogB.getByRole('radio', { name: 'Urgent' })).toBeChecked();
  await dialogB.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(b, 'Ticket saved')).toBeVisible();

  expect(patches(world, '/api/tickets/tkt_1039')).toBe(3);
  expect(sent.at(-1)).toEqual({ version: 4, priority: 'URGENT' });
  const saved = world.tickets.find((t) => t.id === 'tkt_1039')!;
  expect(saved).toMatchObject({ conditionNotes: 'Scratch on the back', priority: 'URGENT' });
});

test('BUG-02 customer: Reload after a conflict takes the colleague’s change and saves only mine', async ({
  browser,
}) => {
  const world = newWorld(ME_WITH_SHOP);
  const [a, b] = await twoTabs(browser, world);
  const sent: Record<string, unknown>[] = [];
  b.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/api/customers/${ALI.id}`))
      sent.push(r.postDataJSON());
  });

  await b.goto(`/customers/${ALI.id}/edit`);
  await expect(b.getByRole('textbox', { name: 'Customer note' })).toHaveValue('');

  await a.goto(`/customers/${ALI.id}/edit`);
  await a.getByRole('textbox', { name: 'Customer note' }).fill('Prefers a call, not SMS');
  await a.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(a, 'Customer saved')).toBeVisible();

  await b.getByRole('textbox', { name: 'Last name' }).fill('Khan-Smith');
  await b.getByRole('button', { name: 'Save changes' }).click();
  await expect(b.getByText('Someone else changed this customer.').first()).toBeVisible();
  await b.getByRole('button', { name: 'Reload' }).click();
  await expect(b.getByRole('textbox', { name: 'Customer note' })).toHaveValue(
    'Prefers a call, not SMS',
  );
  await expect(b.getByRole('textbox', { name: 'Last name' })).toHaveValue('Khan-Smith');
  await b.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(b, 'Customer saved')).toBeVisible();

  expect(sent.at(-1)).toEqual({ version: ALI.version + 1, lastName: 'Khan-Smith' });
  expect(world.customers.find((c) => c.id === ALI.id)).toMatchObject({
    notes: 'Prefers a call, not SMS',
    lastName: 'Khan-Smith',
  });
});

test('customer edit sends only the fields that changed', async ({ page }) => {
  const api = await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto(`/customers/${ALI.id}/edit`);
  await page.getByRole('textbox', { name: 'Last name' }).fill('Khan-Smith');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(toast(page, 'Customer saved')).toBeVisible();
  const patch = api.state.calls.find((c) => c.method === 'PATCH');
  expect(patch?.body).toEqual({ version: ALI.version, lastName: 'Khan-Smith' });
});
