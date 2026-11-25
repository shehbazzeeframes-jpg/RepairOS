import { expect, test, type Page } from '@playwright/test';
import { ME_WITH_SHOP } from './support/mock-api';
import { ST, defaultTickets, mockSprint2, ticket } from './support/sprint2';

/**
 * BUG-05 (docs/qa/sprint2.md): status, assignee and due texts are not cut off at 1024/1440.
 * Failed on main 84df6fb.
 */

// ---------- BUG-05: nothing cut off ----------

async function cutTexts(page: Page, selector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const e of document.querySelectorAll(sel)) {
      const el = e as HTMLElement;
      const text = el.textContent?.trim() ?? '';
      if (!text || text.length > 40 || text === 'Actions') continue;
      // Visually hidden text (1 px boxes) is for screen readers, not cut off.
      if (el.clientWidth > 2 && el.scrollWidth > el.clientWidth + 1) out.push(text);
    }
    return [...new Set(out)];
  }, selector);
}

for (const width of [1440, 1024]) {
  test(`BUG-05 ticket list at ${width}: status and assignee names are not cut off`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const tickets = [
      ...defaultTickets(),
      ticket({
        id: 'tkt_1038',
        number: 1038,
        statusId: ST.approval,
        assignee: { userId: 'usr_9', name: 'Fred Formerly-Employed', active: false },
      }),
      ticket({
        id: 'tkt_1037',
        number: 1037,
        statusId: ST.ready,
        assignee: { userId: 'usr_8', name: 'Maria Manager-Longname', active: true },
      }),
    ];
    await mockSprint2(page, { me: ME_WITH_SHOP, tickets });
    await page.goto('/tickets?view=all');
    await expect(page.getByRole('link', { name: 'T-1038' })).toBeVisible();
    await expect(page.getByText('Fred Formerly-Employed (deactivated)')).toBeVisible();
    expect(await cutTexts(page, 'table tbody *')).toEqual([]);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBe(0);
  });
}

test('BUG-05 ticket detail at 1024: the overdue Due value is not cut off', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets/tkt_1040');
  await expect(page.getByRole('heading', { level: 1, name: 'T-1040' })).toBeVisible();
  await expect(page.getByText(/days overdue/).first()).toBeVisible();
  expect(await cutTexts(page, 'main *, [role="main"] *')).toEqual([]);
});
