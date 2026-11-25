import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Picks an option in an Astryx Selector by role, without racing its open animation (BK2).
 *
 * The old pattern clicked the option as soon as it existed, which sometimes hit it while the popover
 * was still moving in, so the click landed on nothing and the value never changed. This waits for the
 * listbox to be open and the option to be visible (Playwright's click also waits for it to be
 * stable), then checks the trigger shows the choice so a lost click fails here, not three steps later.
 * Runs with `reducedMotion: 'reduce'` (playwright.config.ts) so Astryx skips the animation anyway.
 */
export async function selectOption(
  scope: Page | Locator,
  label: string,
  option: string,
): Promise<void> {
  const page = 'page' in scope ? scope.page() : scope;
  const trigger = scope.getByRole('combobox', { name: label });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const listbox = page.getByRole('listbox').last();
  await expect(listbox).toBeVisible();
  const choice = listbox.getByRole('option', { name: option, exact: true });
  await expect(choice).toBeVisible();
  await choice.click();
  await expect(listbox).toBeHidden();
  await expect(trigger).toContainText(option);
}
