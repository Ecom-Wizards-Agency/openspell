/** Four-series operator chart controls through a production build and migrated fixture. */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('dashboard keeps four KPIs primary and configures four independent chart series', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  await page.goto(`/dashboard?profile=${fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

  const primary = page.getByRole('listbox', { name: /Primary metrics/ });
  await expect(primary.getByRole('option')).toHaveCount(4);
  await primary.getByRole('option').filter({ hasText: 'Orders' }).click();
  await primary.getByRole('option').filter({ hasText: 'ACOS' }).click();
  await expect(page.locator('.wa-cockpit__selection-count')).toContainText('4 of 4 metrics');

  await page.getByLabel('Spend display').selectOption('line');
  await page.getByLabel('Spend axis').selectOption('right');
  await expect(page.getByLabel('Spend display')).toHaveValue('line');
  await expect(page.getByLabel('Spend axis')).toHaveValue('right');
  await expect(page.locator('[data-series-mark="line"][aria-label="Spend line"]')).toBeAttached();
  await expect(page.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Weekly' }).click();
  await expect(page.getByRole('radio', { name: 'Weekly' })).toHaveAttribute('aria-checked', 'true');

  const period = page.locator('.wa-cockpit__period-hit').first();
  await expect(period).toHaveAttribute('tabindex', '0');
  await period.focus();
  await expect(period).toBeFocused();
});
