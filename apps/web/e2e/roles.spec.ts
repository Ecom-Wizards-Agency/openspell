/**
 * "Persist and respect roles", checked from the browser.
 *
 * Runs after `oauth.spec.ts` has connected the account, in the same database,
 * so the roster these tests edit is the one the connect flow produced. Serial
 * mode and a single worker make that ordering real rather than hopeful.
 *
 * Each role is checked twice: what the page offers, and what the server does
 * when the offer is bypassed. For the start route the bypass is a plain GET, so
 * it is asserted directly here; for the two server actions it is asserted in
 * `src/auth/roles.test.ts`, which is where the shared capability table lives.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';

test.describe.configure({ mode: 'serial' });

const INTEGRATION_VALUE = ['synthetic', 'integration', 'e2e', 'value'].join('-');

test('a viewer sees the roster and can change nothing', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.goto('/settings/profiles');

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
  await page.goto('/settings/profiles');

  await expect(page.getByTestId('org-role')).toHaveText('role: analyst');
  await expect(page.getByTestId('save-targets').first()).toBeVisible();
  await expect(page.getByTestId('toggle-sync')).toHaveCount(0);

  const row = page.getByTestId('profile-row').first();
  await row.getByTestId('field-targetAcos').fill('24.5');
  await row.getByTestId('field-targetTotalAcos').fill('18');
  await row.getByTestId('field-goalLens').selectOption('scale');
  await row.getByTestId('field-monthlyBudget').fill('4200');
  await row.getByTestId('save-targets').click();
  // The action re-renders the page; wait for that before asking for a fresh
  // one, so the assertion is about persistence and not about timing.
  await expect(page.getByTestId('field-targetAcos').first()).toHaveValue('24.5');

  // A fresh GET rather than `reload()`: the last navigation was the action's
  // POST, and reloading it re-submits instead of re-reading.
  await page.goto('/settings/profiles');
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
  await page.goto('/settings/profiles?sync=off');

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

  await page.goto('/settings/profiles?sync=on');
  const enabled = page.locator(`[data-profile-id="${profileId}"]`);
  await expect(enabled.getByTestId('toggle-sync')).toHaveValue('1');

  // And the sync-status page sees the same profile as enabled.
  await page.goto('/sync-status');
  await expect(page.getByTestId('freshness-row').first()).toContainText('on');

  // Put it back, so the ordering of later runs is not affected.
  await page.goto('/settings/profiles?sync=on');
  const back = page.locator(`[data-profile-id="${profileId}"]`).getByTestId('toggle-sync');
  await back.selectOption('Off');
  await expect(page.getByTestId('toast')).toContainText('Sync off');
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
});

test('the analyst edit persisted for every role that can read it', async ({ page }) => {
  await signIn(page, 'viewer');
  await page.goto('/settings/profiles');
  const row = page.getByTestId('profile-row').first();
  await expect(row.getByTestId('field-targetAcos')).toHaveText('24.5');
  await expect(row.getByTestId('field-goalLens')).toHaveText('scale');
});

test('filters narrow the roster', async ({ page }) => {
  await signIn(page, 'admin');

  await page.goto('/settings/profiles?region=NA');
  const na = await page.getByTestId('profile-row').count();
  await page.goto('/settings/profiles?region=EU');
  const eu = await page.getByTestId('profile-row').count();
  await page.goto('/settings/profiles');
  const all = await page.getByTestId('profile-row').count();

  expect(na).toBeGreaterThan(0);
  expect(eu).toBeGreaterThan(0);
  expect(na + eu).toBe(all);

  await page.goto('/settings/profiles?q=storefront+1');
  await expect(page.getByTestId('profile-row').first()).toBeVisible();
  await page.goto('/settings/profiles?q=no+such+profile+anywhere');
  await expect(page.getByTestId('roster-empty')).toBeVisible();
});

test('sync status renders the ledgers', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/sync-status');

  await expect(page.getByRole('heading', { name: 'Sync status' })).toBeVisible();
  await expect(page.getByTestId('freshness-row').first()).toBeVisible();
  // The tenant fixture seeds one job and one completed report request.
  await expect(page.getByTestId('job-row')).toHaveCount(1);
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.getByTestId('report-row').first()).toContainText('yes');
});
