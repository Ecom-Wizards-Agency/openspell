/**
 * Bugs and Roadmap end to end: typed intake, voting, triage, legacy redirects,
 * duplicate collapse, and the tenant/role negatives.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const BRIDGE = process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] ?? '';
const ORG_A = process.env['WIZARD_ADS_E2E_ORG_A'] ?? '';
const VIEWER = process.env['WIZARD_ADS_E2E_USER_VIEWER'] ?? '';
const FOREIGN_ITEM = process.env['WIZARD_ADS_E2E_FOREIGN_ITEM'] ?? '';
const ROADMAP_SEEDED = Number(process.env['WIZARD_ADS_E2E_ROADMAP_SEEDED'] ?? '0');

const BUG_TITLE = `Sort resets after export ${Date.now()}`;
const DUPLICATE_TITLE = `Another export ordering failure ${Date.now()}`;
const REQUEST_TITLE = `Bulk apply from the grid ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

const bugCard = (page: Page, title: string): Locator =>
  page.locator('[data-testid="bug-card"]').filter({ hasText: title }).first();

const roadmapCard = (page: Page, title: string): Locator =>
  page.locator('[data-testid="roadmap-card"]').filter({ hasText: title });

test('the bug widget files into the bug home', async ({ page }) => {
  await open(page, '/tags');
  await page.getByTestId('feedback-entry').click();

  await expect(page).toHaveURL(/\/tags$/);
  await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible();
  await expect(page.getByTestId('page-context')).toContainText('page: /tags');
  await expect(page.getByRole('link', { name: 'Full form →' })).toHaveAttribute(
    'href',
    /\/feedback\/new\?type=bug/,
  );

  await page
    .getByTestId('feedback-body')
    .fill(`${BUG_TITLE}\nExporting a filtered view loses the sort order.`);
  await page.getByTestId('feedback-severity').selectOption('high');
  await page.getByTestId('feedback-submit').click();

  await expect(page.getByTestId('toast')).toContainText('Bug filed.');
  await page.getByTestId('toast').getByRole('link', { name: 'View bug' }).click();
  await expect(page).toHaveURL(/\/bugs#bug-/);
  const filed = bugCard(page, BUG_TITLE);
  await expect(filed).toHaveCount(1);
  await expect(filed.getByTestId('item-severity')).toHaveText('high');
  await expect(filed.getByTestId('item-context')).toContainText('/tags');
  await expect(filed.getByTestId('status-select')).toHaveValue('new');
});

test('similar bugs appear before submit and an admin can collapse a duplicate', async ({ page }) => {
  await open(page, '/tags');
  await page.getByTestId('feedback-entry').click();
  await page
    .getByTestId('feedback-body')
    .fill(`${BUG_TITLE}\nThis first line should find the report from the prior test.`);
  await expect(page.getByTestId('similar-bugs')).toContainText(BUG_TITLE);

  await page
    .getByTestId('feedback-body')
    .fill(`${DUPLICATE_TITLE}\nThe same export ordering problem, filed a second time.`);
  await page.getByTestId('feedback-submit').click();
  await page.getByTestId('toast').getByRole('link', { name: 'View bug' }).click();

  const target = bugCard(page, BUG_TITLE);
  const duplicate = bugCard(page, DUPLICATE_TITLE);
  const targetId = await target.getAttribute('data-item-id');
  const duplicateId = await duplicate.getAttribute('data-item-id');
  expect(targetId).not.toBeNull();
  expect(duplicateId).not.toBeNull();
  await duplicate.getByTestId('duplicate-of').fill(targetId ?? '');
  await duplicate.getByTestId('mark-duplicate').click();
  await expect(page.getByRole('status')).toHaveText('Saved');

  const regroupedTarget = page.locator(
    `[data-testid="bug-card"][data-item-id="${targetId}"]`,
  );
  await regroupedTarget.getByTestId('duplicate-group').getByText('Duplicates (1)').click();
  const nested = regroupedTarget.locator(
    `[data-testid="duplicate-card"][data-item-id="${duplicateId}"]`,
  );
  await expect(nested).toContainText(DUPLICATE_TITLE);
  await expect(nested).toContainText(`duplicate of #${targetId}`);
  await expect(
    page.getByTestId('column-open').locator(
      `[data-testid="bug-card"][data-item-id="${duplicateId}"]`,
    ),
  ).toHaveCount(0);
});

test('Roadmap intake preselects feature and puts the request in Requested', async ({ page }) => {
  await open(page, '/roadmap');
  await page.getByRole('link', { name: 'Request a feature' }).click();
  await expect(page).toHaveURL(/\/feedback\/new\?type=feature$/);
  await expect(page.getByRole('heading', { name: 'Request a feature' })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(0);

  await page.getByTestId('feedback-title').fill(REQUEST_TITLE);
  await page.getByTestId('feedback-submit').click();
  await expect(page).toHaveURL(/\/roadmap#roadmap-/);
  const requested = page.getByTestId('column-requested');
  await expect(requested.getByTestId('roadmap-card').filter({ hasText: REQUEST_TITLE })).toHaveCount(
    1,
  );
  await expect(page.getByTestId('column-planned').getByTestId('roadmap-card')).toHaveCount(
    ROADMAP_SEEDED,
  );
});

test('a Roadmap vote toggles and survives reload', async ({ page }) => {
  await open(page, '/roadmap');
  let target = roadmapCard(page, REQUEST_TITLE);
  await expect(target.getByTestId('vote-count')).toHaveText('0');
  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('1');
  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('0');
  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('1');

  await open(page, '/roadmap');
  target = roadmapCard(page, REQUEST_TITLE);
  await expect(target.getByTestId('vote-count')).toHaveText('1');
});

test('an admin triages the feature on Roadmap and controls every move', async ({ page }) => {
  await open(page, '/roadmap');
  let target = roadmapCard(page, REQUEST_TITLE);
  await target.getByTestId('status-select').selectOption('planned');
  await target.getByTestId('admin-note').fill('Next after the grid.');
  await target.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.getByTestId('column-requested').getByText(REQUEST_TITLE)).toHaveCount(0);

  const planned = page.getByTestId('column-planned');
  target = planned.getByTestId('roadmap-card').filter({ hasText: REQUEST_TITLE });
  await expect(target).toHaveCount(1);
  expect(await planned.getByTestId('roadmap-card').count()).toBe(ROADMAP_SEEDED + 1);
  await expect(planned.getByTestId('roadmap-card').first()).toContainText(REQUEST_TITLE);
  await expect(target.getByTestId('vote-count')).toHaveText('1');

  await target.getByTestId('status-select').selectOption('in_progress');
  await target.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(planned.getByText(REQUEST_TITLE)).toHaveCount(0);
  await expect(
    page.getByTestId('column-in-progress').getByTestId('roadmap-card').filter({
      hasText: REQUEST_TITLE,
    }),
  ).toHaveCount(1);
});

test('legacy tracker links redirect by item type', async ({ page }) => {
  await open(page, '/bugs');
  const bugId = await bugCard(page, BUG_TITLE).getAttribute('data-item-id');
  await open(page, '/roadmap');
  const featureId = await roadmapCard(page, REQUEST_TITLE).getAttribute('data-item-id');
  expect(bugId).not.toBeNull();
  expect(featureId).not.toBeNull();

  await page.goto(`/feedback#feedback-${bugId}`);
  await expect(page).toHaveURL(new RegExp(`/bugs#bug-${bugId}$`));
  await page.goto(`/feedback?id=${featureId}`);
  await expect(page).toHaveURL(new RegExp(`/roadmap#roadmap-${featureId}$`));
  await page.goto('/feedback?old=tracker');
  await expect(page).toHaveURL(/\/bugs$/);
});

test.describe('as a viewer', () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': VIEWER,
      'x-wizard-ads-org-id': ORG_A,
    },
  });

  test('can vote, but sees no triage control and is refused a forged update', async ({ page }) => {
    await open(page, '/roadmap');
    await expect(page.getByTestId('status-select')).toHaveCount(0);
    await expect(page.getByTestId('triage-readonly').first()).toBeVisible();

    const target = roadmapCard(page, REQUEST_TITLE);
    await target.getByTestId('vote-button').click();
    await expect(target.getByTestId('vote-count')).toHaveText('2');

    const itemId = await target.getAttribute('data-item-id');
    const forged = await page.request.patch(`/api/feedback/${itemId}`, {
      data: { status: 'shipped' },
    });
    expect(forged.status()).toBe(403);
  });
});

test('an admin can decline a feature with a visible reason', async ({ page }) => {
  await open(page, '/roadmap');
  const target = roadmapCard(page, REQUEST_TITLE);
  await target.getByTestId('status-select').selectOption('declined');
  await target.getByTestId('admin-note').fill('Not planned while the grid changes.');
  await target.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');

  const declined = page.getByTestId('declined-card').filter({ hasText: REQUEST_TITLE });
  await expect(declined).toHaveCount(1);
  await expect(declined.getByTestId('declined-note')).toContainText('Not planned');
});

test.describe("as another tenant's member", () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': process.env['WIZARD_ADS_E2E_USER_B'] ?? '',
      'x-wizard-ads-org-id': process.env['WIZARD_ADS_E2E_ORG_B'] ?? '',
    },
  });

  test('sees none of the first tenant on either board', async ({ page }) => {
    await open(page, '/bugs');
    await expect(page.getByText(BUG_TITLE)).toHaveCount(0);
    await open(page, '/roadmap');
    await expect(page.getByText(REQUEST_TITLE)).toHaveCount(0);
    await expect(page.getByTestId('column-planned').getByTestId('roadmap-card')).toHaveCount(0);
  });
});

test("another tenant's item is a 404, not a 403", async ({ page }) => {
  const read = await page.request.get(`/api/feedback/${FOREIGN_ITEM}`);
  expect(read.status()).toBe(404);
  const voted = await page.request.post(`/api/feedback/${FOREIGN_ITEM}/vote`);
  expect(voted.status()).toBe(404);
  const triaged = await page.request.patch(`/api/feedback/${FOREIGN_ITEM}`, {
    data: { status: 'shipped' },
  });
  expect(triaged.status()).toBe(404);
});
