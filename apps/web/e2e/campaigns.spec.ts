/**
 * Guided campaign planning through the production server and migrated test DB.
 * The only outbound artifact is a manual Bulk Operations workbook.
 */
import { expect, test } from '@playwright/test';

test('guided create previews every row and exports a workbook without an Amazon action', async ({ page }) => {
  await page.goto('/campaigns');
  await expect(page.getByRole('heading', { name: 'Campaign Builder', exact: true })).toBeVisible();
  await expect(page.getByText('Neither action changes Amazon')).toBeVisible();

  await page.getByRole('tab', { name: 'Create new' }).click();
  await page.getByLabel('Product name').fill('Synthetic widget');
  await page.getByLabel('Target descriptor').fill('core');
  await page.getByLabel('Seller SKU').fill('SKU-SYNTHETIC');
  await page.getByLabel('Keywords').fill('synthetic keyword');

  await expect(page.getByTestId('campaign-name-preview')).toContainText('Synthetic widget');
  await expect(page.getByTestId('campaign-builder-advanced')).not.toHaveAttribute('open', '');

  await page.getByRole('button', { name: 'Preview campaign plan' }).click();
  const previewRows = page.getByTestId('campaign-update-rows').locator('tbody tr');
  await expect(previewRows.first()).toBeVisible();
  const rowCount = await previewRows.count();
  expect(rowCount).toBeGreaterThan(0);
  await expect(page.getByText('Ready to export', { exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download bulksheet' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  await expect(page.getByText('Manual upload file · no Amazon API write')).toBeVisible();
});
