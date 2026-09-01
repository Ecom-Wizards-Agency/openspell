import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test.describe.configure({ mode: 'serial' });

test('edits a canonical local weekday schedule and still queues a manual preview', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  await page.goto(`/optimizer/groups?profile=${fixtureProfileId}`);

  await expect(page.getByRole('heading', { name: 'Optimization Groups', exact: true })).toBeVisible();
  await expect(page.getByText('UTC · 04:00 local')).toBeVisible();

  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayChecks = weekdayNames.map((name) => page.getByRole('checkbox', { name, exact: true }));
  for (const checkbox of weekdayChecks) await expect(checkbox).toBeChecked();

  for (const checkbox of weekdayChecks.slice(1)) await checkbox.uncheck();
  await weekdayChecks[0]?.click();
  await expect(weekdayChecks[0]!).toBeChecked();

  await page.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved 1 campaign assignment');
  await expect(page.getByText(/Target ACOS .* · Mon$/)).toBeVisible();

  // Weekday eligibility belongs only to the default-off scheduler. An
  // operator's manual preview remains available and still creates no Amazon write.
  await page.getByRole('button', { name: 'Run group preview', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preview queued');
  await expect(page.getByRole('status')).toContainText('Amazon is unchanged');
});
