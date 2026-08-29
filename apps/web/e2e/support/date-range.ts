import { expect, type Page } from '@playwright/test';

const PRESETS = [
  'Last 7 days',
  'Last 14 days',
  'Last 30 days',
  'Last 60 days',
  'Last 90 days',
  'Month to date',
  'Previous month',
] as const;

/** Prove the native disclosure opens and every promised preset is actionable. */
export async function expectDateRangePresets(page: Page): Promise<void> {
  const picker = page.locator('details.wa-date-range');
  await expect(picker).toHaveCount(1);

  const trigger = picker.locator('summary');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(picker).toHaveAttribute('open', '');

  const presets = picker.getByRole('navigation', { name: 'Date range presets' });
  await expect(presets.getByRole('link')).toHaveCount(PRESETS.length);
  for (const label of PRESETS) {
    await expect(presets.getByRole('link', { name: label, exact: true })).toBeVisible();
  }

  await trigger.click();
  await expect(picker).not.toHaveAttribute('open');
}
