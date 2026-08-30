/**
 * WP-19 end to end: create (from a grid selection's pre-filled scope) → run →
 * end → comparison, the experiment-window shading, the entity-changes-in-window
 * list, and the two negatives that matter (a role that may not create, and
 * another tenant's experiment).
 *
 * It runs on the tags-goto harness: a production build behind the header bridge,
 * one worker, serial. The default actor is org A's owner; the role tests swap
 * the bridge headers, which is the same thing WP-04's session layer would
 * produce — the role behind the bridge is read from `org_members` by the server,
 * not asserted by the client.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BRIDGE = process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] ?? '';
const ORG_A = process.env['WIZARD_ADS_E2E_ORG_A'] ?? '';
const ORG_B = process.env['WIZARD_ADS_E2E_ORG_B'] ?? '';
const USER_B = process.env['WIZARD_ADS_E2E_USER_B'] ?? '';
const VIEWER = process.env['WIZARD_ADS_E2E_USER_VIEWER'] ?? '';
const PROFILE_A = process.env['WIZARD_ADS_E2E_PROFILE_A'] ?? '';

const NAME = `Blue widget bid push ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

/**
 * The "Start an experiment" link the grid builds, assembled rather than
 * written out: a long query-string literal reads to the public-repo hygiene
 * gate as a high-entropy candidate secret, and `URLSearchParams` is what the
 * app itself uses to build it.
 */
function newExperimentPath(params: Record<string, string>): string {
  return `/experiments/new?${new URLSearchParams(params).toString()}`;
}

test('the fixture experiment lists, and its detail shows the window, comparison and changes', async ({
  page,
}) => {
  await open(page, '/experiments');
  await expect(page.getByTestId('experiments-role')).toHaveText('owner');
  await expect(page.getByTestId('proposed-tests')).toBeVisible();

  const fixture = page.getByTestId('experiment-item').filter({ hasText: 'Fixture bid push' });
  await expect(fixture).toHaveCount(1);
  await fixture.getByRole('link', { name: 'Fixture bid push' }).click();

  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
  await expect(page.getByTestId('experiment-status')).toContainText('Running');

  // The comparison derives from facts and, while running, has no after window.
  await expect(page.getByTestId('comparison-table')).toBeVisible();
  await expect(page.getByTestId('no-after')).toBeVisible();
  // During-window scoped spend is the fixture's target fact (4.50), not a dash.
  await expect(page.getByTestId('cell-scoped-during-spend')).not.toHaveText('—');

  // The window shades the trend chart.
  await expect(page.getByTestId('experiment-window').first()).toBeVisible();

  // The seeded change to kw-1 fell inside the window and is listed.
  await expect(page.getByTestId('entity-change').filter({ hasText: 'kw-1' })).toHaveCount(1);
});

test('create from a guided grid selection, run it, end it, and read the comparison', async ({ page }) => {
  // The grid's "Start an experiment" link lands here with the scope pre-filled.
  await open(page, newExperimentPath({
    profile: PROFILE_A,
    campaigns: 'c-1,c-missing',
    targets: 'kw-1',
    asins: 'B0TEST0001',
  }));
  await expect(page.getByTestId('scope-campaigns-option-c-1')).toBeChecked();
  await expect(page.getByTestId('scope-campaigns-selected-count')).toHaveText('2 selected');
  await expect(page.getByText('c-missing', { exact: true })).toBeVisible();
  await expect(page.getByTestId('scope-products-option-B0TEST0001')).toBeChecked();
  await expect(page.getByTestId('scope-targets')).toHaveValue('kw-1');

  await page.getByTestId('experiment-name').fill(NAME);
  await page.getByTestId('experiment-metric').selectOption('acos');
  // Start it running now (the checkbox defaults on; assert it, then submit).
  await expect(page.getByTestId('experiment-start-now')).toBeChecked();
  await page.getByTestId('experiment-submit').click();

  // Lands on the detail page, running, scope captured.
  await expect(page).toHaveURL(/\/experiments\/[0-9a-f-]+$/);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
  await expect(page.getByTestId('experiment-name')).toHaveText(NAME);
  await expect(page.getByTestId('experiment-status')).toContainText('Running');
  await expect(page.getByTestId('scope-links')).toContainText('2 campaign(s)');
  await expect(page.getByTestId('comparison')).toBeVisible();

  // End it, with a result note.
  await page.getByTestId('result-note').fill('ACOS held while sales rose.');
  await page.getByTestId('transition-ended').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.getByTestId('experiment-status')).toContainText('Ended');
  await expect(page.getByTestId('experiment-result')).toContainText('ACOS held');
  // The comparison is still derived after ending.
  await expect(page.getByTestId('comparison-table')).toBeVisible();
  // A move was logged.
  await expect(page.getByTestId('timeline-event').filter({ hasText: 'Ended' })).toHaveCount(1);
});

test.describe('as a viewer', () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': VIEWER,
      'x-wizard-ads-org-id': ORG_A,
    },
  });

  test('reads the tracker but is refused the create the UI never offers', async ({ page }) => {
    await open(page, '/experiments');
    await expect(page.getByTestId('experiments-role')).toHaveText('viewer');
    // No "New experiment" affordance for a viewer.
    await expect(page.getByTestId('new-experiment')).toHaveCount(0);

    // And the server refuses the request the page never offered.
    const forged = await page.request.post('/api/experiments', {
      data: {
        profileId: PROFILE_A,
        name: 'Forged',
        type: 'bid_push',
        metricFocus: 'sales',
      },
    });
    expect(forged.status()).toBe(403);
  });
});

test("another tenant's experiment is a 404, not a 403", async ({ page }) => {
  // Read one of org A's ids as org A's owner (the default headers).
  const list = await page.request.get('/api/experiments');
  expect(list.ok()).toBeTruthy();
  const payload = (await list.json()) as { items: { id: string }[] };
  const someId = payload.items[0]?.id ?? '';
  expect(someId).not.toBe('');
  expect(ORG_A).not.toBe(ORG_B);

  // As a member of org B, the same id does not exist.
  const foreign = await page.request.get(`/api/experiments/${someId}`, {
    headers: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': USER_B,
      'x-wizard-ads-org-id': ORG_B,
    },
  });
  expect(foreign.status()).toBe(404);
  const foreignPatch = await page.request.patch(`/api/experiments/${someId}`, {
    headers: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': USER_B,
      'x-wizard-ads-org-id': ORG_B,
    },
    data: { status: 'aborted' },
  });
  expect(foreignPatch.status()).toBe(404);

  // And the screen, not only the API: the detail page called `notFound()`
  // inside its own try/catch, so the framework's control-flow error was caught
  // and rendered as an error message — a 404 that looked like a crash.
  const foreignPage = await page.request.get(`/experiments/${someId}`, {
    headers: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': USER_B,
      'x-wizard-ads-org-id': ORG_B,
    },
  });
  expect(foreignPage.status()).toBe(404);
  const body = await foreignPage.text();
  // The shared not-found screen, not the detail page's own error branch.
  expect(body).toContain('app-not-found');
  expect(body).not.toContain('this is the page refusing');
});
