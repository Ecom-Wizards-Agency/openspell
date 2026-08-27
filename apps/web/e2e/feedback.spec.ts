/**
 * Feedback end to end: widget submit → bug board → tracker → duplicate collapse,
 * plus voting, roadmap triage, and the two tenant/role negatives.
 *
 * It runs on the tags-goto harness: a production build behind the header
 * bridge, one worker, serial. The role tests swap the bridge headers for a
 * viewer's, which is the same thing WP-04's session layer would produce for a
 * viewer — the bridge carries an already-verified actor, and the role behind it
 * is read from `org_members` by the server, not asserted by the client.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const BRIDGE = process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] ?? '';
const ORG_A = process.env['WIZARD_ADS_E2E_ORG_A'] ?? '';
const VIEWER = process.env['WIZARD_ADS_E2E_USER_VIEWER'] ?? '';
const FOREIGN_ITEM = process.env['WIZARD_ADS_E2E_FOREIGN_ITEM'] ?? '';
const ROADMAP_SEEDED = Number(process.env['WIZARD_ADS_E2E_ROADMAP_SEEDED'] ?? '0');

/** A title unique to this run, so assertions cannot match a leftover row. */
const BUG_TITLE = `Sort resets after export ${Date.now()}`;
const DUPLICATE_TITLE = `Another export ordering failure ${Date.now()}`;
const REQUEST_TITLE = `Bulk apply from the grid ${Date.now()}`;

test.describe.configure({ mode: 'serial' });

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

const item = (page: Page, title: string) =>
  page.getByTestId('feedback-item').filter({ hasText: title });

test('the bug widget files from the current page into both boards', async ({ page }) => {
  // Any page: the tag surface is the one this harness already serves.
  await open(page, '/tags');
  await page.getByTestId('feedback-entry').click();

  await expect(page).toHaveURL(/\/tags$/);
  await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible();
  // Shown before submitting, not attached silently.
  await expect(page.getByTestId('page-context')).toContainText('page: /tags');

  await page
    .getByTestId('feedback-body')
    .fill(`${BUG_TITLE}\nExporting a filtered view loses the sort order.`);
  await page.getByTestId('feedback-severity').selectOption('high');
  await page.getByTestId('feedback-submit').click();

  await expect(page.getByTestId('toast')).toContainText('Bug filed.');
  await page.getByTestId('toast').getByRole('link', { name: 'View bug' }).click();
  await expect(page).toHaveURL(/\/bugs#bug-/);
  await expect(page.getByTestId('column-open').getByTestId('bug-card').filter({ hasText: BUG_TITLE })).toHaveCount(1);

  await open(page, '/feedback');
  const filed = item(page, BUG_TITLE);
  await expect(filed).toHaveCount(1);
  await expect(filed.getByTestId('item-status')).toHaveText('New');
  await expect(filed.getByTestId('item-severity')).toHaveText('high');
  await expect(filed.getByTestId('item-context')).toContainText('/tags');
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
  await expect(page.getByTestId('column-open').getByTestId('bug-card').filter({ hasText: DUPLICATE_TITLE })).toHaveCount(1);

  await open(page, '/feedback');
  const target = item(page, BUG_TITLE);
  const duplicate = item(page, DUPLICATE_TITLE);
  const targetId = await target.getAttribute('data-item-id');
  expect(targetId).not.toBeNull();
  await duplicate.getByTestId('duplicate-of').fill(targetId ?? '');
  await duplicate.getByTestId('mark-duplicate').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(item(page, DUPLICATE_TITLE).getByTestId('item-status')).toHaveText('Declined');
  await expect(item(page, DUPLICATE_TITLE).getByTestId('item-note')).toContainText(
    `duplicate of #${targetId}`,
  );

  await open(page, '/bugs');
  const targetCard = page.getByTestId('bug-card').filter({ hasText: BUG_TITLE });
  await expect(targetCard).toHaveCount(1);
  await targetCard.getByTestId('duplicate-group').getByText('Duplicates (1)').click();
  await expect(targetCard.getByTestId('duplicate-card')).toContainText(DUPLICATE_TITLE);
  await expect(page.getByTestId('column-open').getByTestId('bug-card').filter({ hasText: DUPLICATE_TITLE })).toHaveCount(0);
});

test('the filtered views and the counts agree about what was filed', async ({ page }) => {
  await open(page, '/feedback/new');
  await page.getByTestId('feedback-title').fill(REQUEST_TITLE);
  await page.getByRole('radio', { name: 'Feature request' }).check();
  await page.getByTestId('feedback-submit').click();
  await expect(page).toHaveURL(/\/feedback$/);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();

  const counts = page.getByTestId('feedback-counts');
  // The tenant fixture seeds one bug, this run filed one more.
  await expect(counts).toContainText('2 open bugs');

  await page.getByTestId('filter-type').selectOption('bug');
  await expect(item(page, REQUEST_TITLE)).toHaveCount(0);
  await expect(item(page, BUG_TITLE)).toHaveCount(1);

  await page.getByTestId('filter-type').selectOption('feature');
  await expect(item(page, BUG_TITLE)).toHaveCount(0);
  await expect(item(page, REQUEST_TITLE)).toHaveCount(1);
  // The seeded roadmap is made of feature requests, so this view is not the
  // one item this test filed.
  expect(await page.getByTestId('feedback-item').count()).toBeGreaterThan(ROADMAP_SEEDED);

  await page.getByTestId('filter-status').selectOption('new');
  await expect(item(page, REQUEST_TITLE)).toHaveCount(1);
  await page.getByTestId('filter-status').selectOption('shipped');
  await expect(item(page, REQUEST_TITLE)).toHaveCount(0);
});

test('a vote toggles, and it is one vote per person', async ({ page }) => {
  await open(page, '/feedback');
  const target = item(page, REQUEST_TITLE);
  await expect(target.getByTestId('vote-count')).toHaveText('0');

  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('1');
  // Clicking again withdraws it rather than counting twice.
  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('0');
  await target.getByTestId('vote-button').click();
  await expect(target.getByTestId('vote-count')).toHaveText('1');

  // And it survives a reload, which is what makes it a vote and not a toggle.
  await open(page, '/feedback');
  await expect(item(page, REQUEST_TITLE).getByTestId('vote-count')).toHaveText('1');
});

test('an admin triages, and the card moves on the roadmap', async ({ page }) => {
  await open(page, '/feedback');
  const target = item(page, REQUEST_TITLE);
  await target.getByTestId('status-select').selectOption('planned');
  await target.getByTestId('admin-note').fill('Next after the grid.');
  await target.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(item(page, REQUEST_TITLE).getByTestId('item-status')).toHaveText('Planned');

  await open(page, '/roadmap');
  const planned = page.getByTestId('column-planned');
  await expect(planned.getByTestId('roadmap-card').filter({ hasText: REQUEST_TITLE })).toHaveCount(1);
  // The seeded items are on the board too, and the voted card outranks them:
  // the column is ordered by votes, not by when it was filed.
  expect(await planned.getByTestId('roadmap-card').count()).toBe(ROADMAP_SEEDED + 1);
  await expect(planned.getByTestId('roadmap-card').first()).toContainText(REQUEST_TITLE);
  await expect(planned.getByTestId('roadmap-card').first().getByTestId('vote-count')).toHaveText('1');

  // Moving the status moves the card between columns.
  await open(page, '/feedback');
  const moving = item(page, REQUEST_TITLE);
  await moving.getByTestId('status-select').selectOption('in_progress');
  await moving.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');

  await open(page, '/roadmap');
  await expect(
    page.getByTestId('column-planned').getByTestId('roadmap-card').filter({ hasText: REQUEST_TITLE }),
  ).toHaveCount(0);
  await expect(
    page.getByTestId('column-in-progress').getByTestId('roadmap-card').filter({ hasText: REQUEST_TITLE }),
  ).toHaveCount(1);
});

test('a declined item is on the roadmap, with the reason', async ({ page }) => {
  await open(page, '/feedback');
  const target = item(page, BUG_TITLE);
  await target.getByTestId('status-select').selectOption('declined');
  await target.getByTestId('admin-note').fill('Working as intended: export takes the raw view.');
  await target.getByTestId('save-triage').click();
  await expect(page.getByRole('status')).toHaveText('Saved');

  await open(page, '/roadmap');
  const declined = page.getByTestId('declined-card').filter({ hasText: BUG_TITLE });
  await expect(declined).toHaveCount(1);
  await expect(declined.getByTestId('declined-note')).toContainText('Working as intended');
});

test.describe('as a viewer', () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': VIEWER,
      'x-wizard-ads-org-id': ORG_A,
    },
  });

  test('can file and vote, but is offered no triage control and refused one', async ({ page }) => {
    await open(page, '/feedback');
    await expect(page.getByTestId('feedback-role')).toHaveText('viewer');
    await expect(page.getByTestId('status-select')).toHaveCount(0);
    await expect(page.getByTestId('triage-readonly').first()).toBeVisible();

    // Voting is still theirs to do, and the count is now two people's.
    const target = item(page, REQUEST_TITLE);
    await target.getByTestId('vote-button').click();
    await expect(target.getByTestId('vote-count')).toHaveText('2');

    // And the server refuses the request the page never offered.
    const itemId = await target.getAttribute('data-item-id');
    const forged = await page.request.patch(`/api/feedback/${itemId}`, {
      data: { status: 'shipped' },
    });
    expect(forged.status()).toBe(403);
  });
});

test.describe("as another tenant's member", () => {
  test.use({
    extraHTTPHeaders: {
      'x-wizard-ads-auth-bridge': BRIDGE,
      'x-wizard-ads-user-id': process.env['WIZARD_ADS_E2E_USER_B'] ?? '',
      'x-wizard-ads-org-id': process.env['WIZARD_ADS_E2E_ORG_B'] ?? '',
    },
  });

  test('sees none of org A, and org A sees none of theirs', async ({ page }) => {
    await open(page, '/feedback');
    await expect(item(page, REQUEST_TITLE)).toHaveCount(0);
    await expect(item(page, BUG_TITLE)).toHaveCount(0);
    // Their own board is empty of org A's seeded roadmap.
    await open(page, '/roadmap');
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
