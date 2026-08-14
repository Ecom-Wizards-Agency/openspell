/**
 * The four browser flows WP-07 is accepted on:
 *
 *   1. the provenance panel renders every `inputs` field, plus the change
 *      reason, the limit reason and the strategy that produced the proposal;
 *   2. accept → export moves the status and produces the three files, and a
 *      dismissed proposal is not in the export;
 *   3. the export gesture is three separate acts: select, confirm, press;
 *   4. the n-gram explorer toggles uni/bi/tri and turns a gram into proposals
 *      without writing anything.
 *
 * Everything runs against a real Next server on a real migrated database; see
 * `e2e/run.ts`, which also seeds the run and the search terms.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PROFILE = process.env['WIZARD_ADS_E2E_PROFILE_A'] ?? '';
const PROPOSALS = Number(process.env['WIZARD_ADS_E2E_REC_PROPOSALS'] ?? '0');
const SEARCH_TERMS = Number(process.env['WIZARD_ADS_E2E_REC_SEARCH_TERMS'] ?? '0');

const INPUT_KEYS = ['rpc', 'clicks', 'cvrSourceLevel', 'ceilingApplied', 'capClamped', 'window'];

async function openReview(page: Page): Promise<void> {
  await page.goto(`/recommendations?profile=${PROFILE}`);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

async function openExplorer(page: Page): Promise<void> {
  await page.goto(`/ngrams?profile=${PROFILE}`);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

test.describe('recommendations review', () => {
  test('shows every proposal grouped by reason, with its work and its strategy', async ({ page }) => {
    await openReview(page);

    // Grouped by reason, and the coverage strip says how concentrated the run is.
    await expect(page.getByTestId('reason-group-high_acos')).toBeVisible();
    await expect(page.getByTestId('reason-group-low_visibility')).toBeVisible();
    await expect(page.getByTestId('reason-coverage')).toContainText('High ACOS');

    const rows = page.locator('tr[data-testid^="proposal-"]');
    await expect(rows).toHaveCount(PROPOSALS);

    // The objective column: resolved from the run's own strategy snapshot.
    const first = rows.first();
    const id = (await first.getAttribute('data-testid'))?.replace('proposal-', '') ?? '';
    await expect(page.getByTestId(`objective-${id}`)).toHaveText('Rank · rank-launch');

    await first.getByRole('button', { name: 'Show work' }).click();
    const panel = page.getByTestId(`provenance-${id}`);
    await expect(panel).toBeVisible();
    for (const key of INPUT_KEYS) {
      await expect(panel.locator(`[data-provenance="${key}"]`)).toHaveCount(1);
    }
    // Change reason and limit reason are two facts, not one.
    await expect(panel).toContainText('Change reason');
    await expect(page.getByTestId(`limit-${id}`)).toContainText('data_based_ad_group');
    await expect(page.getByTestId(`strategy-${id}`)).toContainText('rank-launch');
  });

  test('accept, dismiss and export: the three-act gesture, and dismissed rows never export', async ({
    page,
  }) => {
    await openReview(page);

    // Dismiss the low-visibility proposal, with the note the route demands.
    const lowVisibility = page.getByTestId('reason-group-low_visibility').locator('tr[data-testid^="proposal-"]').first();
    await lowVisibility.getByRole('checkbox').check();
    await page.getByLabel('Decision note').fill('Rank target: never cut on ACOS alone.');
    await page.getByRole('button', { name: 'Dismiss selected' }).click();
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    await expect(page.getByTestId('run-counts')).toContainText('1 dismissed');

    // Accept everything still proposed.
    await page.getByRole('combobox', { name: 'Status' }).selectOption('proposed');
    await page.getByRole('button', { name: /Select all \d+ filtered/ }).click();
    await page.getByLabel('Decision note').fill('Formula results, ceilings stated.');
    await page.getByRole('button', { name: 'Accept selected' }).click();
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    await expect(page.getByTestId('run-counts')).toContainText(`${PROPOSALS - 1} accepted`);

    // Act two of the gesture is separate from act three: pressing Export
    // without the confirmation is refused.
    await page.getByLabel('Decision note').fill('Weekly rank batch.');
    await page.getByLabel('Opt group').fill('Rank');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByTestId('review-error')).toContainText('I confirm this export');

    await page.getByRole('checkbox', { name: 'I confirm this export' }).check();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const result = page.getByTestId('export-result');
    await expect(result).toContainText(`Exported ${PROPOSALS - 1} of ${PROPOSALS - 1} accepted`);
    await expect(result).toContainText('-rank-bid-down');
    // The caps come from the Rank group in the run's own snapshot.

    // The files exist and the rows JSON holds exactly the exported set — the
    // dismissed proposal is not in it.
    const href = (await result.textContent())?.match(/rows (\/api\S+)/)?.[1] ?? '';
    expect(href).not.toBe('');
    const rows = await page.request.get(href);
    expect(rows.ok()).toBe(true);
    const parsed = (await rows.json()) as { entity_id: string; field: string }[];
    expect(parsed).toHaveLength(PROPOSALS - 1);
    expect(parsed.some((row) => row.entity_id === 'tg-1')).toBe(false);

    const workbook = await page.request.get(href.replace('format=rows', 'format=xlsx'));
    expect(workbook.ok()).toBe(true);
    expect(workbook.headers()['content-disposition']).toContain('-bulk.xlsx');
    expect(workbook.headers()['x-wizard-ads-skipped-rows']).toBe('0');

    const caps = await page.request.get(href.replace('format=rows', 'format=caps'));
    expect(caps.ok()).toBe(true);
    const capsBody = (await caps.json()) as { validateCommand: string; targetAcos: number };
    expect(capsBody.validateCommand).toContain('batches.py validate');
    expect(capsBody.targetAcos).toBe(0.4);

    // And the statuses moved.
    await openReview(page);
    await expect(page.getByTestId('run-counts')).toContainText(`exported ${PROPOSALS - 1} of`);
    await expect(page.locator('tr[data-status="dismissed"]')).toHaveCount(1);
  });
});

test.describe('n-gram explorer', () => {
  test('toggles gram size and proposes negatives without writing anything', async ({ page }) => {
    await openExplorer(page);
    await expect(page.getByTestId('gram-count')).toContainText(`${SEARCH_TERMS} search terms`);

    // Bigrams by default; unigrams pool the same terms differently, and the
    // count changes without a round trip because the engine runs in the page.
    const bigrams = (await page.getByTestId('gram-count').textContent()) ?? '';
    await page.getByRole('button', { name: 'Unigrams' }).click();
    await expect(page.getByTestId('gram-count')).not.toHaveText(bigrams);

    // Click a gram to see the terms behind it: you negate terms, not grams.
    await page.getByTestId('grid-row').first().click();
    const terms = page.getByTestId('gram-terms');
    await expect(terms).toBeVisible();

    const selectAll = terms.getByRole('button', { name: /Select all \d+/ });
    const chosen = Number(((await selectAll.textContent()) ?? '').match(/\d+/)?.[0] ?? '0');
    expect(chosen).toBeGreaterThan(0);
    expect(chosen).toBeLessThanOrEqual(SEARCH_TERMS);
    await selectAll.click();
    await terms.getByRole('button', { name: 'Propose selected as negatives' }).click();

    const result = page.getByTestId('propose-result');
    await expect(result).toContainText(`Proposed ${chosen} of ${chosen} negatives`);
    await expect(result).toContainText('Nothing was negated');

    // They are reviewable like any other proposal, in their own run — the
    // newest one, which the review screen lists first.
    await page.goto(`/recommendations?profile=${PROFILE}`);
    await page.getByRole('navigation', { name: 'Runs' }).getByRole('link').first().click();
    await expect(page.getByTestId('reason-group-flag')).toBeVisible();
    await expect(page.locator('tr[data-testid^="proposal-"]')).toHaveCount(chosen);
  });
});
