/** Ordered nested grouping through the real session guard and production grid model. */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { expectDateRangePresets } from './support/date-range';

test('grid adds, reorders, and removes truthful nested grouping levels', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/grid?entity=campaigns');
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await expectDateRangePresets(page);
  // Server-rendered controls are visible before React owns them. The grid only
  // becomes ready after hydration and saved-layout restoration, either of
  // which could otherwise discard an early grouping change.
  await expect(page.getByTestId('grid-workspace')).toHaveAttribute('data-ready', 'true');

  const addLevel = page.getByLabel('Add grouping level');
  await addLevel.selectOption({ label: 'State' });
  await addLevel.selectOption({ label: 'Ad type' });
  await addLevel.selectOption({ label: 'Campaign' });

  const tree = page.getByRole('treegrid');
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="1"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="2"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="3"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV \(1 deepest group\)/ })).toBeVisible();

  const levels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(levels.getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Move Campaign up' }).click();
  await expect(levels.getByRole('listitem').nth(1)).toContainText('Campaign');
  await page.getByRole('button', { name: 'Remove grouping level Ad type' }).click();
  await expect(levels.getByRole('listitem')).toHaveCount(2);
});
