/**
 * WP-30 end to end: the Time Machine change history.
 *
 * Runs on the tags-goto harness — a production build behind the header bridge,
 * one worker, serial — the same as the experiments and recommendations suites.
 * The default actor is org A's owner.
 *
 * The suite shares one database across serial specs, and earlier ones (the
 * recommendations export) add their own apply-batches to org A. So these
 * assertions key off a distinctive marker change that `e2e/run.ts` seeds for
 * org A only, and off the presence of each source, rather than a global row
 * count — the exact counts are pinned in `packages/db`'s query suite instead.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BRIDGE = process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] ?? '';
const ORG_B = process.env['WIZARD_ADS_E2E_ORG_B'] ?? '';
const USER_B = process.env['WIZARD_ADS_E2E_USER_B'] ?? '';
const PROFILE_A = process.env['WIZARD_ADS_E2E_PROFILE_A'] ?? '';

/** Kept in sync with `TIME_MACHINE_MARKER` in `e2e/run.ts`: a campaign budget change. */
const MARKER = 'ZZ Time Machine Marker';

test.describe.configure({ mode: 'serial' });

const ROUTE = '/time-machine';
const GRID = '/grid';

/**
 * URLs are assembled rather than written out. A long dense query string trips
 * the hygiene linter's entropy check as a candidate secret, which is the same
 * false positive the repo's own guidance answers by building the string from
 * fragments at runtime.
 */
function url(params: Record<string, string> = {}): string {
  return `${ROUTE}?${new URLSearchParams({ profile: PROFILE_A, ...params }).toString()}`;
}

async function open(page: Page, params: Record<string, string> = {}): Promise<void> {
  await page.goto(url(params));
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

test('the timeline shows both a sync-detected change and an operator apply', async ({ page }) => {
  await open(page);

  // Both source kinds are present and labelled.
  expect(await page.getByTestId('entry-source').filter({ hasText: 'Sync' }).count()).toBeGreaterThan(0);
  expect(await page.getByTestId('entry-source').filter({ hasText: 'Applied' }).count()).toBeGreaterThan(0);

  // The distinctive campaign change renders once, with its old→new values.
  const marker = page.getByTestId('timeline-entry').filter({ hasText: MARKER });
  await expect(marker).toHaveCount(1);
  await expect(marker).toContainText('10');
  await expect(marker).toContainText('15');
  await expect(marker.getByTestId('entry-source')).toHaveText('Sync');

  // Day grouping renders a dated header.
  await expect(page.getByTestId('timeline-day').first()).toBeVisible();

  // A campaign entry deep-links into the grid where the change can be inspected.
  const expected = `${GRID}?${new URLSearchParams({ profile: PROFILE_A, entity: 'campaigns' })}`;
  await expect(marker.getByTestId('entry-goto')).toHaveAttribute('href', expected);
});

test('filters narrow by source, entity type and field', async ({ page }) => {
  // Source = operator apply: no sync entries survive, so the sync-sourced marker is gone.
  await open(page, { source: 'apply' });
  await expect(page.getByTestId('entry-source').filter({ hasText: 'Sync' })).toHaveCount(0);
  await expect(page.getByText(MARKER)).toHaveCount(0);

  // Source = sync: the marker is back.
  await open(page, { source: 'sync' });
  await expect(page.getByText(MARKER)).toHaveCount(1);

  // Entity type = keyword: a campaign change is excluded.
  await open(page, { type: 'keyword' });
  await expect(page.getByText(MARKER)).toHaveCount(0);

  // Entity type = campaign: the marker survives.
  await open(page, { type: 'campaign' });
  await expect(page.getByText(MARKER)).toHaveCount(1);

  // Field = bid excludes the budget marker; field = budget keeps it.
  await open(page, { field: 'bid' });
  await expect(page.getByText(MARKER)).toHaveCount(0);
  await open(page, { field: 'budget' });
  await expect(page.getByText(MARKER)).toHaveCount(1);

  // A window before any change exists is an explicit filtered-empty state.
  await open(page, { from: '2000-01-01', to: '2000-12-31' });
  await expect(page.getByTestId('timeline-empty-filtered')).toBeVisible();
  await expect(page.getByTestId('timeline-entry')).toHaveCount(0);
});

test('the filter form carries the selected values', async ({ page }) => {
  await open(page, { source: 'apply', type: 'keyword', field: 'bid' });
  await expect(page.getByTestId('filter-source')).toHaveValue('apply');
  await expect(page.getByTestId('filter-type')).toHaveValue('keyword');
  await expect(page.getByTestId('filter-field')).toHaveValue('bid');
  // The clear affordance appears only when a filter is active.
  await expect(page.getByTestId('filter-clear')).toBeVisible();
});

test.describe('as another tenant', () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': USER_B,
      'x-wizard-ads-org-id': ORG_B,
    },
  });

  test("org B sees its own history but never org A's changes", async ({ page }) => {
    // No profile parameter: org A's id would not resolve for this tenant anyway,
    // and the page falls back to the first profile the actor's own org owns.
    await page.goto(ROUTE);
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    // Org B has its own fixture history…
    expect(await page.getByTestId('timeline-entry').count()).toBeGreaterThan(0);
    // …and crucially, never org A's marker.
    await expect(page.getByText(MARKER)).toHaveCount(0);
  });
});
