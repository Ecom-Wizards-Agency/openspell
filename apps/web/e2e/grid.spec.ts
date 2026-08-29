/** Ordered nested grouping through the real session guard and production grid model. */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { expectDateRangePresets } from './support/date-range';
import { readState } from './support/fixture';

test.beforeEach(async ({ page }) => applyRequestedCpuThrottle(page));

test('grid restores the matching saved filter, grouping, and sort before becoming interactive', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const savedLayout = {
    id: 'saved-campaign-layout',
    name: 'Saved campaign layout',
    entity: 'campaigns',
    columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
    pinned: ['campaign_name'],
    widths: { campaign_name: 280 },
    filter: {
      groups: [{ filters: [{ key: 'CAMPAIGN_ID', conditions: [{ operator: '=', values: ['c-1'] }] }] }],
    },
    sort: [{ columnId: 'clicks', direction: 'asc' }],
    groupBy: ['campaign_state'],
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    {
      key: 'wizard-ads:layout:v1',
      value: JSON.stringify({ campaigns: savedLayout }),
    },
  );

  // Hold hydration so the server-rendered, pre-ready contract is observable
  // without timing guesses. Releasing the promise lets the real Next chunks
  // hydrate and the real LocalViewStore restore the saved layout.
  let releaseChunks = (): void => {};
  const chunksReleased = new Promise<void>((resolve) => {
    releaseChunks = resolve;
  });
  await page.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, async (route) => {
    await chunksReleased;
    await route.continue();
  });

  const gridQuery = new URLSearchParams({ profile: fixtureProfileId, entity: 'campaigns' });
  await page.goto(`/grid?${gridQuery.toString()}`, { waitUntil: 'commit' });
  const workspace = page.getByTestId('grid-workspace');
  try {
    await expect(workspace).toHaveAttribute('data-ready', 'false');
    await expect(page.getByTestId('grid-layout-restoring')).toBeVisible();
    await expect(page.getByTestId('grid-scroller')).toHaveCount(0);
    await expect(page.getByTestId('grid-start-experiment')).toHaveCount(0);
    const preReadyLayout = await page.evaluate(() => {
      const raw = window.localStorage.getItem('wizard-ads:layout:v1');
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as {
        campaigns?: { filter?: unknown; groupBy?: unknown; sort?: unknown };
      };
      return parsed.campaigns ?? null;
    });
    expect(preReadyLayout).toMatchObject({
      filter: savedLayout.filter,
      groupBy: savedLayout.groupBy,
      sort: savedLayout.sort,
    });
  } finally {
    releaseChunks();
  }

  await expect(workspace).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('treegrid', { name: 'Results grouped by campaign_state' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Clicks' })).toHaveAttribute('aria-sort', 'ascending');
  const restoredFilter = page.getByRole('button', { name: 'Remove filter CAMPAIGN_ID' }).locator('..');
  await expect(restoredFilter).toContainText('Campaign ID equals c-1');
  const restoredLevels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(restoredLevels.getByRole('listitem')).toHaveCount(1);
  await expect(restoredLevels.getByRole('listitem')).toContainText('State');
  await expect(page.getByTestId('grid-start-experiment')).toHaveAttribute('href', /campaigns=c-1/);

  await page.getByRole('columnheader', { name: 'Spend' }).click();
  await expect(page.getByRole('columnheader', { name: 'Spend' })).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('wizard-ads:layout:v1');
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { campaigns?: { sort?: unknown } };
        return parsed.campaigns?.sort ?? null;
      }),
    )
    .toEqual([{ columnId: 'spend', direction: 'desc' }]);
});

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
