import { test } from '@playwright/test';
import { ME_WITH_SHOP } from './support/mock-api';
import { mockSprint2 } from './support/sprint2';
test.use({ viewport: { width: 1024, height: 768 } });
test('measure', async ({ page }) => {
  await mockSprint2(page, { me: ME_WITH_SHOP });
  await page.goto('/tickets');
  await page.getByRole('link', { name: 'T-1042' }).waitFor();
  console.log(
    await page.evaluate(() => {
      const t = (document.querySelector('table') ?? document.querySelector('[role=table]'))!;
      const cols = [...t.querySelectorAll('th,[role=columnheader]')].map(
        (th) => `${th.textContent}:${Math.round(th.getBoundingClientRect().width)}`,
      );
      return JSON.stringify({
        table: t.scrollWidth,
        parent: t.parentElement!.clientWidth,
        main: document.querySelector('main')?.clientWidth,
        cols,
      });
    }),
  );
});
