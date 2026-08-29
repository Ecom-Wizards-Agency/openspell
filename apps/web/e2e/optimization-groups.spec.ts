import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('weekday review schedule shows local time, persists choices, and leaves Run now available', async ({ page }) => {
  await signIn(page, 'analyst');
  const { fixtureProfileId } = await readState();
  await page.goto(`/optimizer/groups?profile=${fixtureProfileId}`);

  await expect(page.getByTestId('optimization-review-schedule')).toBeVisible();
  await expect(page.getByTestId('review-timezone')).toHaveText('UTC');
  await expect(page.locator('.wa-weekday-chip')).toHaveCount(7);
  await expect(page.getByText('Review schedules create previews only.')).toBeVisible();

  await page.getByRole('checkbox', { name: 'Tue' }).uncheck();
  await page.getByLabel('Local review time').fill('11:45');
  await page.getByRole('checkbox', { name: 'Scheduled previews' }).uncheck();
  await page.getByRole('button', { name: 'Save group' }).click();
  await expect(page.getByRole('status').last()).toContainText('Saved 1 campaign assignment');

  await page.goto(`/optimizer/groups?profile=${fixtureProfileId}`);
  await expect(page.getByLabel('Local review time')).toHaveValue('11:45');
  await expect(page.getByRole('checkbox', { name: 'Tue' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Scheduled previews' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Run preview now' })).toBeEnabled();
});
