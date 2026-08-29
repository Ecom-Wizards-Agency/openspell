/** Cross-route acceptance for the shared reporting window and legacy strategy link. */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/auth';
import { expectDateRangePresets } from './support/date-range';
import { readState } from './support/fixture';

async function choosePreset({
  page,
  path,
  heading,
  profileId,
  preset,
}: {
  page: Page;
  path: '/optimizer' | '/creative';
  heading: 'Campaign Optimizer' | 'Creative Performance';
  profileId: string;
  preset: 'Last 14 days' | 'Last 60 days';
}): Promise<void> {
  await page.goto(`${path}?profile=${profileId}`);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expectDateRangePresets(page);

  const picker = page.locator('details.wa-date-range');
  const trigger = picker.locator('summary');
  const before = new URL(page.url());
  expect(before.pathname).toBe(path);
  expect(before.searchParams.get('profile')).toBe(profileId);

  await trigger.click();
  await picker.getByRole('link', { name: preset, exact: true }).click();
  await page.waitForURL((url) => (
    url.pathname === path
      && url.searchParams.get('profile') === profileId
      && url.searchParams.has('from')
      && url.searchParams.has('to')
  ));

  const selected = new URL(page.url());
  expect(selected.searchParams.get('profile')).toBe(profileId);
  expect(selected.searchParams.get('from')).not.toBe(before.searchParams.get('from'));
  await expect(
    page.locator('details.wa-date-range > summary'),
  ).toHaveAttribute('aria-label', `Date range: ${preset}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await signIn(page, 'admin');
});

test('optimizer exposes all date presets and preserves canonical account scope', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  await choosePreset({
    page,
    path: '/optimizer',
    heading: 'Campaign Optimizer',
    profileId: fixtureProfileId,
    preset: 'Last 14 days',
  });
});

test('creative exposes all date presets and preserves canonical account scope', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  await choosePreset({
    page,
    path: '/creative',
    heading: 'Creative Performance',
    profileId: fixtureProfileId,
    preset: 'Last 60 days',
  });
});

test('legacy strategy links land on the dashboard operating status', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  await page.goto(`/strategy?profile=${fixtureProfileId}`);

  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  await page.waitForURL((url) => (
    url.pathname === '/dashboard'
      && url.searchParams.get('profile') === fixtureProfileId
      && url.hash === '#operating-status'
  ));
  await expect(page.locator('#operating-status')).toBeVisible();
});
