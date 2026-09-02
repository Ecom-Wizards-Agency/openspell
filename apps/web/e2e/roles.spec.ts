/**
 * "Persist and respect roles", checked from the browser.
 *
 * This file owns the one additional profile its role and filter assertions
 * need. It therefore passes alone as well as after `oauth.spec.ts`; file order
 * is not test setup.
 *
 * Each role is checked twice: what the page offers, and what the server does
 * when the offer is bypassed. For the start route the bypass is a plain GET, so
 * it is asserted directly here; for the two server actions it is asserted in
 * `src/auth/roles.test.ts`, which is where the shared capability table lives.
 */
import { createDb } from '@wizard-ads/db';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { readState } from './support/fixture';

test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ page }) => applyRequestedCpuThrottle(page));

const INTEGRATION_VALUE = ['synthetic', 'integration', 'e2e', 'value'].join('-');
const ROLE_PROFILE_ID = ['roles', 'profile', 'fixture'].join('-');

/**
 * The role suite needs one disabled EU profile: the sync test starts from Off,
 * and the filter test must have both NA and EU inputs. OAuth happens to create
 * those rows in the complete run, but an exact-spec invocation must be equally
 * truthful, so this file creates and removes its own row.
 */
test.beforeAll(async () => {
  const state = await readState();
  const handle = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const rows = await handle.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone,
         account_name, sync_enabled)
      values (${state.orgId}, ${ROLE_PROFILE_ID}, 'EU', 'DE', 'EUR', 'UTC',
              'AAA synthetic storefront 1', false)
      on conflict (org_id, amazon_profile_id) do update
        set region = excluded.region,
            country_code = excluded.country_code,
            currency_code = excluded.currency_code,
            timezone = excluded.timezone,
            account_name = excluded.account_name,
            sync_enabled = excluded.sync_enabled,
            target_acos = null,
            target_total_acos = null,
            goal_lens = null,
            monthly_budget = null
      returning id
    `;
    if (rows.length !== 1) throw new Error(`Prepared 1 role profile, wrote ${rows.length}`);
  } finally {
    await handle.close();
  }
});

test.afterAll(async () => {
  const state = await readState();
  const handle = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const rows = await handle.sql<{ id: string }[]>`
      delete from public.ad_profiles
       where org_id = ${state.orgId} and amazon_profile_id = ${ROLE_PROFILE_ID}
      returning id
    `;
    if (rows.length !== 1) throw new Error(`Removed 1 role profile, deleted ${rows.length}`);
  } finally {
    await handle.close();
  }
});

async function openProfiles(page: Page, path = '/settings/profiles'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('profile-editor')).toHaveAttribute('data-interactive', 'true');
}

test('a viewer sees the roster and can change nothing', async ({ page }) => {
  await signIn(page, 'viewer');
  await openProfiles(page);

  await expect(page.getByTestId('org-role')).toHaveText('role: viewer');
  await expect(page.getByTestId('read-only-notice')).toBeVisible();
  await expect(page.getByTestId('toggle-sync')).toHaveCount(0);
  await expect(page.getByTestId('save-targets')).toHaveCount(0);
  await expect(page.getByTestId('sync-readonly').first()).toBeVisible();

  await page.goto('/settings/connections');
  await expect(page.getByTestId('connect-forbidden')).toBeVisible();
  await expect(page.getByTestId('connect-amazon')).toHaveCount(0);

  await page.goto('/settings/integrations');
  await expect(page.getByTestId('integrations-read-only')).toBeVisible();
  await expect(page.getByTestId('connect-integration-keepa')).toHaveCount(0);
  await expect(page.getByTestId('revoke-integration-keepa')).toHaveCount(0);

  const response = await page.request.get('/api/amazon/oauth/start', { maxRedirects: 0 });
  expect(response.status()).toBe(403);
});

test('an analyst edits targets but cannot toggle sync or connect', async ({ page }) => {
  await signIn(page, 'analyst');
  await openProfiles(page);

  await expect(page.getByTestId('org-role')).toHaveText('role: analyst');
  await expect(page.getByTestId('save-targets').first()).toBeVisible();
  await expect(page.getByTestId('toggle-sync')).toHaveCount(0);

  const row = page.getByTestId('profile-row').first();
  await row.getByTestId('field-targetAcos').fill('24.5');
  await row.getByTestId('field-targetTotalAcos').fill('18');
  await row.getByTestId('field-goalLens').selectOption('scale');
  await row.getByTestId('field-monthlyBudget').fill('4200');
  const targetPost = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/settings/profiles',
  );
  await row.getByTestId('save-targets').click();
  const targetResponse = await targetPost;
  await targetResponse.finished();
  // The action re-renders the page; wait for that before asking for a fresh
  // one, so the assertion is about persistence and not about timing.
  await expect(page.getByTestId('field-targetAcos').first()).toHaveValue('24.5');

  // A fresh GET rather than `reload()`: the last navigation was the action's
  // POST, and reloading it re-submits instead of re-reading.
  await openProfiles(page);
  const saved = page.getByTestId('profile-row').first();
  await expect(saved.getByTestId('field-targetAcos')).toHaveValue('24.5');
  await expect(saved.getByTestId('field-targetTotalAcos')).toHaveValue('18');
  await expect(saved.getByTestId('field-goalLens')).toHaveValue('scale');
  await expect(saved.getByTestId('field-monthlyBudget')).toHaveValue('4200');

  const response = await page.request.get('/api/amazon/oauth/start', { maxRedirects: 0 });
  expect(response.status()).toBe(403);
});

test('an admin toggles sync and the change survives a reload', async ({ page }) => {
  await signIn(page, 'admin');
  await openProfiles(page, '/settings/profiles?sync=off');

  // WP-21 made the sync control a Select (On/Off) with a toast on save,
  // replacing the click-toggle button whose label was its own state. The
  // assertions are the same behaviour — off flips to on, it persists, the
  // sync-status page agrees — expressed against the dropdown, plus the toast the
  // redesign added as the confirmation the button never gave.
  const row = page.getByTestId('profile-row').first();
  const profileId = await row.getAttribute('data-profile-id');
  const control = row.getByTestId('toggle-sync');
  await expect(control).toHaveValue('0');
  await control.selectOption('On');
  // Wait for the save to confirm before navigating: the write is an optimistic
  // transition, and leaving before it resolves would race the revalidation.
  await expect(page.getByTestId('toast')).toContainText('Sync on');

  await openProfiles(page, '/settings/profiles?sync=on');
  const enabled = page.locator(`[data-profile-id="${profileId}"]`);
  await expect(enabled.getByTestId('toggle-sync')).toHaveValue('1');

  // And the sync-status page sees the same profile as enabled.
  await page.goto('/sync-status');
  await expect(page.getByTestId('freshness-row').first()).toContainText('on');

  // Put it back, so the ordering of later runs is not affected.
  await openProfiles(page, '/settings/profiles?sync=on');
  const back = page.locator(`[data-profile-id="${profileId}"]`).getByTestId('toggle-sync');
  await back.selectOption('Off');
  await expect(page.getByTestId('toast')).toContainText('Sync off');
});

test('an admin persists a schedule and bulk-syncs the exact selected synthetic row', async ({ page }) => {
  await signIn(page, 'admin');
  const syntheticQuery = 'q=AAA+synthetic+storefront+1';
  await openProfiles(page, `/settings/profiles?${syntheticQuery}`);
  await expect(page.getByTestId('profile-row')).toHaveCount(1);

  const row = page.getByTestId('profile-row');
  await row.getByTestId('field-timezone').fill('Europe/Berlin');
  await row.getByTestId('field-syncHour').fill('7');
  const schedulePost = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/settings/profiles',
  );
  await row.getByTestId('save-schedule').click();
  const scheduleResponse = await schedulePost;
  await scheduleResponse.finished();

  await openProfiles(page, `/settings/profiles?${syntheticQuery}`);
  const persisted = page.getByTestId('profile-row');
  await expect(persisted.getByTestId('field-timezone')).toHaveValue('Europe/Berlin');
  await expect(persisted.getByTestId('field-syncHour')).toHaveValue('7');
  await expect(persisted.getByTestId('timezone-locked')).toHaveText('pinned');

  // Selection begins only after the provider's explicit hydration marker. The
  // unique filter makes the input count, selected count and changed count all
  // exactly one, and afterAll deletes this disposable profile.
  await page.getByTestId('row-select-all').check();
  await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
  await expect(page.getByTestId('bulk-enable')).toBeEnabled();
  await page.getByTestId('bulk-enable').click();
  await expect(page.getByTestId('toast')).toContainText('Sync on for 1 profile.');
  await expect(page.getByTestId('bulk-count')).toHaveText('No profiles selected');

  await openProfiles(page, `/settings/profiles?${syntheticQuery}&sync=on`);
  await expect(page.getByTestId('profile-row')).toHaveCount(1);
  await expect(page.getByTestId('toggle-sync')).toHaveValue('1');

  await page.getByTestId('row-select-all').check();
  await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
  await page.getByTestId('bulk-disable').click();
  await expect(page.getByTestId('toast')).toContainText('Sync off for 1 profile.');

  await openProfiles(page, `/settings/profiles?${syntheticQuery}&sync=off`);
  await expect(page.getByTestId('profile-row')).toHaveCount(1);
  await expect(page.getByTestId('toggle-sync')).toHaveValue('0');
});

test('an admin stores an integration key once and can revoke it', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings/integrations');

  await page.getByTestId('integration-label-datadive').fill('E2E DataDive');
  await page.getByTestId('integration-secret-datadive').fill(INTEGRATION_VALUE);
  await page.getByTestId('submit-integration-datadive').click();

  const row = page.getByTestId('integration-row-datadive').filter({ hasText: 'E2E DataDive' });
  await expect(row).toContainText('active');
  await expect(page.getByTestId('integration-secret-datadive')).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(INTEGRATION_VALUE);

  await row.getByTestId('revoke-integration-datadive').click();
  await expect(
    page.getByTestId('integration-row-datadive').filter({ hasText: 'E2E DataDive' }),
  ).toContainText('revoked');

  await page.getByTestId('integration-label-datadive').fill('E2E DataDive');
  await page
    .getByTestId('integration-secret-datadive')
    .fill(`${INTEGRATION_VALUE}-rotated`);
  await page.getByTestId('submit-integration-datadive').click();
  await expect(
    page.getByTestId('integration-row-datadive').filter({ hasText: 'E2E DataDive' }),
  ).toHaveCount(1);
  await expect(
    page.getByTestId('integration-row-datadive').filter({ hasText: 'E2E DataDive' }),
  ).toContainText('active');
});

test('the analyst edit persisted for every role that can read it', async ({ page }) => {
  await signIn(page, 'viewer');
  await openProfiles(page);
  const row = page.getByTestId('profile-row').first();
  await expect(row.getByTestId('field-targetAcos')).toHaveText('24.5');
  await expect(row.getByTestId('field-goalLens')).toHaveText('scale');
});

test('filters narrow the roster', async ({ page }) => {
  await signIn(page, 'admin');

  await openProfiles(page, '/settings/profiles?region=NA');
  const na = await page.getByTestId('profile-row').count();
  await openProfiles(page, '/settings/profiles?region=EU');
  const eu = await page.getByTestId('profile-row').count();
  await openProfiles(page);
  const all = await page.getByTestId('profile-row').count();

  expect(na).toBeGreaterThan(0);
  expect(eu).toBeGreaterThan(0);
  expect(na + eu).toBe(all);

  await openProfiles(page, '/settings/profiles?q=storefront+1');
  await expect(page.getByTestId('profile-row').first()).toBeVisible();
  await openProfiles(page, '/settings/profiles?q=no+such+profile+anywhere');
  await expect(page.getByTestId('roster-empty')).toBeVisible();
});

test('sync status renders the ledgers', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/sync-status');

  await expect(page.getByRole('heading', { name: 'Sync status' })).toBeVisible();
  await expect(page.getByTestId('freshness-row').first()).toBeVisible();
  // The tenant fixture seeds the unified-report dispatch plus WP-195's inert,
  // completed recommendation-preview custody job, and one report request.
  const jobs = page.getByTestId('job-row');
  await expect(jobs).toHaveCount(2);
  expect((await jobs.locator('td:nth-child(1)').allTextContents()).sort()).toEqual([
    'e2e-profile-1',
    'e2e-profile-1',
  ]);
  expect((await jobs.locator('td:nth-child(2)').allTextContents()).sort()).toEqual([
    'recommendations.run',
    'report.unified.advance',
  ]);
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.getByTestId('report-row').first()).toContainText('yes');
});
