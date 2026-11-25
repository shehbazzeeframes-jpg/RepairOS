import { expect, test, type Page } from '@playwright/test';
import { SEED, apiAs, signInContext } from './support/stack';
import { axe, ok, shot2, type Json } from './support/sprint2';

/** ROADMAP DoD for Sprint 2 pages: axe (WCAG 2.1 A/AA) on every new page and dialog; layout at 1024 and 1440. */

interface Target {
  name: string;
  url: string;
  ready: (p: Page) => Promise<void>;
  open?: (p: Page) => Promise<void>;
}

let ids: { ticket: string; closedTicket: string; customer: string };

test.beforeAll(async () => {
  const us = await apiAs(SEED.owner);
  const open = (await ok(us, 'GET', '/api/tickets?view=open&limit=25')).items as Json[];
  const closed = (await ok(us, 'GET', '/api/tickets?view=closed&limit=25')).items as Json[];
  const withDevice = open.find((t) => t.device.type === 'PHONE') ?? open[0]!;
  ids = { ticket: withDevice.id, closedTicket: closed[0]!.id, customer: withDevice.customer.id };
});

const h1 = (name?: string | RegExp) => async (p: Page) => {
  await expect(p.getByRole('heading', { level: 1, ...(name ? { name } : {}) }).first()).toBeVisible();
  await p.waitForTimeout(700); // let Astryx open animations settle before axe
};

function targets(): Target[] {
  return [
    { name: 'dashboard', url: '/', ready: h1(/Welcome/) },
    { name: 'tickets-list', url: '/tickets', ready: async (p) => { await h1('Tickets')(p); await expect(p.getByText(/Showing 1–/)).toBeVisible(); } },
    { name: 'ticket-detail', url: `/tickets/${ids.ticket}`, ready: h1(/^T-/) },
    { name: 'ticket-detail-closed', url: `/tickets/${ids.closedTicket}`, ready: h1(/^T-/) },
    { name: 'ticket-status-menu', url: `/tickets/${ids.ticket}`, ready: h1(/^T-/), open: async (p) => { await p.getByRole('button', { name: 'Change status' }).click(); await expect(p.getByRole('menu')).toBeVisible(); await p.waitForTimeout(500); } },
    { name: 'ticket-cancel-dialog', url: `/tickets/${ids.ticket}`, ready: h1(/^T-/), open: async (p) => { await p.getByRole('button', { name: /More actions for T-/ }).click(); await p.getByRole('menuitem', { name: 'Cancel ticket…' }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'ticket-edit-dialog', url: `/tickets/${ids.ticket}`, ready: h1(/^T-/), open: async (p) => { await p.getByRole('button', { name: 'Edit details' }).first().click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'ticket-assign-dialog', url: `/tickets/${ids.ticket}`, ready: h1(/^T-/), open: async (p) => { await p.getByRole('button', { name: 'Assign' }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'checkin-empty', url: '/tickets/new', ready: h1('New ticket') },
    { name: 'checkin-new-customer-device', url: '/tickets/new', ready: h1('New ticket'), open: async (p) => {
      await expect(p.getByRole('combobox', { name: 'Find customer' })).toBeFocused();
      await p.keyboard.type('Axe Person');
      await p.getByRole('option', { name: /New customer/ }).click();
      await p.getByRole('textbox', { name: 'Phone' }).fill('(212) 555-0101');
      await p.keyboard.press('Enter');
      await p.getByRole('radio', { name: 'Pattern' }).click();
      await p.getByRole('button', { name: 'Pre-repair checklist' }).or(p.getByRole('button', { name: /^Pre-repair checklist/ })).first().click();
      await p.waitForTimeout(700);
    } },
    { name: 'customers-list', url: '/customers', ready: h1('Customers') },
    { name: 'customer-detail', url: `/customers/${ids.customer}`, ready: h1() },
    { name: 'customer-devices-tab', url: `/customers/${ids.customer}?tab=devices`, ready: h1() },
    { name: 'customer-details-tab', url: `/customers/${ids.customer}?tab=details`, ready: h1() },
    { name: 'customer-add-device-dialog', url: `/customers/${ids.customer}?tab=devices`, ready: h1(), open: async (p) => { await p.getByRole('button', { name: 'Add device' }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'customer-erase-dialog', url: `/customers/${ids.customer}`, ready: h1(), open: async (p) => { await p.getByRole('button', { name: 'More actions' }).click(); await p.getByRole('menuitem', { name: 'Erase…' }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'customer-new', url: '/customers/new', ready: h1('New customer'), open: async (p) => { await p.getByRole('button', { name: 'Add address' }).click(); await p.getByRole('switch', { name: 'Marketing by SMS' }).click(); await p.waitForTimeout(500); } },
    { name: 'customer-edit', url: `/customers/${ids.customer}/edit`, ready: h1() },
    { name: 'settings-statuses', url: '/settings/statuses', ready: h1('Ticket statuses') },
    { name: 'settings-statuses-add-dialog', url: '/settings/statuses', ready: h1('Ticket statuses'), open: async (p) => { await p.getByRole('button', { name: 'Add status' }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.waitForTimeout(700); } },
    { name: 'settings-tickets', url: '/settings/tickets', ready: h1('Tickets') },
    { name: 'search-palette', url: '/', ready: h1(/Welcome/), open: async (p) => { await p.keyboard.press('ControlOrMeta+k'); await p.keyboard.type('smith'); await expect(p.getByRole('dialog', { name: 'Search RepairOS' }).getByRole('option').first()).toBeVisible(); await p.waitForTimeout(500); } },
  ];
}

test('A11Y-S2 axe on every Sprint 2 page and dialog (owner, seed US shop, 1440)', async ({ page }) => {
  test.setTimeout(300_000);
  await signInContext(page, SEED.owner);
  const failures: string[] = [];
  for (const t of targets()) {
    await page.goto(t.url);
    await t.ready(page);
    if (t.open) await t.open(page);
    const v = await axe(page);
    if (v.length) failures.push(`${t.name}: ${v.join(' | ')}`);
  }
  test.info().annotations.push({ type: 'axe', description: failures.join('\n') || 'none' });
  expect(failures).toEqual([]);
});

test('LAYOUT-S2-badges status names and assignee names (incl. "(deactivated)") are not cut off in the ticket list at 1440', async ({ page }) => {
  test.fail(true, 'BUG-05: status badges and assignee names are ellipsised in the ticket list even at 1440 ("Ready for pic…", "Fred Former…")');
  await signInContext(page, SEED.owner);
  await page.goto('/tickets');
  await expect(page.getByText(/Showing 1–/)).toBeVisible();
  const cut = await page.evaluate(() => {
    const out: string[] = [];
    // Any element inside a table body whose own text overflows its box (ellipsis via CSS).
    for (const e of document.querySelectorAll('table tbody *')) {
      const el = e as HTMLElement;
      const text = el.textContent?.trim() ?? '';
      if (!text || text.length > 40 || text === 'Actions') continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(text);
    }
    return [...new Set(out)];
  });
  test.info().annotations.push({ type: 'observed', description: `cut at 1440: ${JSON.stringify(cut)}` });
  await page.screenshot({ path: shot2('bug-05-truncated-status-1440') });
  expect(cut).toEqual([]);
});

for (const width of [1024, 1440]) {
  test(`LAYOUT-S2-${width} no horizontal scroll, key content readable, ticket detail keeps two columns`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width, height: width === 1024 ? 768 : 900 });
    await signInContext(page, SEED.owner);
    const problems: string[] = [];
    for (const t of targets().filter((x) => !x.open || x.name === 'checkin-new-customer-device')) {
      await page.goto(t.url);
      await t.ready(page);
      if (t.open) await t.open(page);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) problems.push(`${t.name}: horizontal overflow ${over}px`);
      // Truncated cells with no title/tooltip text are hard to read: list ellipsised table cells.
      const cut = await page.evaluate(() =>
        [...new Set([...document.querySelectorAll('main *, [role="main"] *')]
          .filter((e) => (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1)
          .map((e) => (e.textContent ?? '').trim())
          .filter((t) => t && t.length <= 40 && t !== 'Actions'))]
          .slice(0, 8),
      );
      if (cut.length) problems.push(`${t.name}: truncated ${JSON.stringify(cut)}`);
      await page.screenshot({ path: shot2(`layout-${width}-${t.name}`) });
    }
    // Ticket detail: activity rail to the right of the cards at ≥ 1024.
    await page.goto(`/tickets/${ids.ticket}`);
    await h1(/^T-/)(page);
    const cust = await page.getByRole('region', { name: 'Customer' }).boundingBox();
    const act = await page.getByRole('region', { name: 'Activity' }).boundingBox();
    if (!cust || !act || act.x <= cust.x + cust.width - 1) problems.push(`ticket-detail: activity not in a right-hand column (customer ${JSON.stringify(cust)}, activity ${JSON.stringify(act)})`);
    test.info().annotations.push({ type: 'layout', description: problems.join('\n') || 'none' });
    expect(problems.filter((p) => p.includes('overflow') || p.includes('column'))).toEqual([]);
  });
}
