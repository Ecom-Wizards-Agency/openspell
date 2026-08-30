/** Cross-route acceptance for the shared reporting window and legacy strategy link. */
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { expectDateRangePresets } from './support/date-range';
import { readState } from './support/fixture';

interface ExpectedPreset {
  label: string;
  from: string;
  to: string;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addUtcDays(value: string, days: number): string {
  return isoDate(new Date(new Date(`${value}T00:00:00.000Z`).getTime() + days * 86_400_000));
}

function expectedPresets(serverDate: string): ExpectedPreset[] {
  const today = isoDate(new Date(serverDate));
  const end = addUtcDays(today, -1);
  const monthStart = `${end.slice(0, 8)}01`;
  const previousMonthEnd = addUtcDays(monthStart, -1);
  const previousMonthStart = `${previousMonthEnd.slice(0, 8)}01`;
  const trailing = (label: string, days: number): ExpectedPreset => ({
    label,
    from: addUtcDays(end, -(days - 1)),
    to: end,
  });

  return [
    trailing('Last 7 days', 7),
    trailing('Last 14 days', 14),
    trailing('Last 30 days', 30),
    trailing('Last 60 days', 60),
    trailing('Last 90 days', 90),
    { label: 'Month to date', from: monthStart, to: end },
    { label: 'Previous month', from: previousMonthStart, to: previousMonthEnd },
  ];
}

async function exerciseEveryPreset({
  page,
  path,
  heading,
  profileId,
}: {
  page: Page;
  path: '/optimizer' | '/creative';
  heading: 'Campaign Optimizer' | 'Creative Performance';
  profileId: string;
}): Promise<void> {
  const response = await page.goto(`${path}?profile=${profileId}`);
  const serverDate = response?.headers()['date'];
  expect(serverDate, 'the server response provides the UTC day used by the route').toBeTruthy();
  if (serverDate === undefined) throw new Error('Missing Date response header');
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  await expectDateRangePresets(page);

  await page.evaluate(() => {
    (window as Window & { __openspellRouteAcceptance?: string }).__openspellRouteAcceptance =
      'same-document';
  });
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  const visited: string[] = [];
  for (const preset of expectedPresets(serverDate)) {
    const picker = page.locator('details.wa-date-range');
    await picker.locator('summary').click();
    await picker.getByRole('link', { name: preset.label, exact: true }).click();
    await page.waitForURL((url) => (
      url.pathname === path
        && url.searchParams.get('profile') === profileId
        && url.searchParams.get('from') === preset.from
        && url.searchParams.get('to') === preset.to
    ));

    const selected = new URL(page.url());
    expect(selected.pathname).toBe(path);
    expect(selected.searchParams.get('profile')).toBe(profileId);
    expect(selected.searchParams.get('from')).toBe(preset.from);
    expect(selected.searchParams.get('to')).toBe(preset.to);
    await expect(
      page.locator('details.wa-date-range > summary'),
    ).toHaveAttribute('aria-label', `Date range: ${preset.label}`);
    visited.push(preset.label);
  }

  expect(visited).toEqual(expectedPresets(serverDate).map(({ label }) => label));
  expect(await page.evaluate(
    () => (window as Window & { __openspellRouteAcceptance?: string })
      .__openspellRouteAcceptance,
  )).toBe('same-document');
  expect(documentRequests).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await applyRequestedCpuThrottle(page);
  await signIn(page, 'admin');
});

test('optimizer exposes all date presets and preserves canonical account scope', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  await exerciseEveryPreset({
    page,
    path: '/optimizer',
    heading: 'Campaign Optimizer',
    profileId: fixtureProfileId,
  });
});

test('creative exposes all date presets and preserves canonical account scope', async ({ page }) => {
  const { fixtureProfileId } = await readState();
  await exerciseEveryPreset({
    page,
    path: '/creative',
    heading: 'Creative Performance',
    profileId: fixtureProfileId,
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
  const destination = page.locator('#operating-status');
  await expect(destination).toBeVisible();
  await expect(destination).toBeInViewport();
});
