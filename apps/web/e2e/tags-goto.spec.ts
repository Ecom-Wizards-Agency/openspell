/**
 * The four browser flows WP-08 is accepted on:
 *
 *   1. tag a campaign set, then filter the list and the dashboard count by it;
 *   2. a goto link round-trips the filter state through a real redirect;
 *   3. an expired token is a 404;
 *   4. another tenant's token is a 404.
 *
 * Everything runs against a real Next server on a real migrated database; see
 * `e2e/run.ts`.
 *
 * Locators go through roles rather than `getByLabel`, because these labels
 * wrap their `<select>` and the label's text therefore includes every option.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const EXPIRED_TOKEN = process.env['WIZARD_ADS_E2E_EXPIRED_TOKEN'] ?? '';
const FOREIGN_TOKEN = process.env['WIZARD_ADS_E2E_FOREIGN_TOKEN'] ?? '';
const CAMPAIGN_TOTAL = Number(process.env['WIZARD_ADS_E2E_CAMPAIGN_TOTAL'] ?? '0');

const campaignList = (page: Page) => page.getByTestId('campaign-list').getByRole('listitem');
const dashboardCount = (page: Page) => page.getByLabel('Dashboard tag summary');
const tagSelect = (page: Page) => page.getByRole('combobox', { name: 'Tag', exact: true });
const modeSelect = (page: Page) => page.getByRole('combobox', { name: 'Mode' });
const descendantsBox = (page: Page) => page.getByRole('checkbox', { name: 'Include child tags' });

/**
 * Open the page and wait until React owns the controls. Clicking a
 * server-rendered form before hydration submits it natively, which looks like
 * a passing click and changes nothing.
 */
async function openTags(page: Page, path = '/tags'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
}

test.describe('tags and goto links', () => {
  test('tagging a campaign set drives both the list and the dashboard count', async ({ page }) => {
    await openTags(page);
    // The seed: one campaign already carries the fixture tag, the rest do not.
    await expect(campaignList(page)).toHaveCount(CAMPAIGN_TOTAL);

    const tagName = `Launch set ${Date.now()}`;
    await page.getByRole('textbox', { name: 'Name' }).fill(tagName);
    await page.getByRole('button', { name: 'Create tag' }).click();
    // The component reloads after a successful mutation: the new tag appearing
    // proves the reload, the marker proves the new page is interactive again.
    await expect(page.getByRole('listitem').filter({ hasText: tagName })).toBeVisible();
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();

    // Select the campaigns that carry no tag yet, and tag exactly those.
    await modeSelect(page).selectOption('untagged');
    const untagged = CAMPAIGN_TOTAL - 1;
    await expect(campaignList(page)).toHaveCount(untagged);
    await expect(dashboardCount(page)).toContainText(String(untagged));

    await page.getByRole('combobox', { name: 'Bulk assignment tag' }).selectOption({ label: tagName });
    await page.getByRole('button', { name: 'Tag filtered campaigns' }).click();
    // After the reload the filter is back to its default, so every campaign is
    // listed and exactly the bulk-tagged ones carry the new tag.
    await expect(campaignList(page)).toHaveCount(CAMPAIGN_TOTAL);
    await expect(campaignList(page).filter({ hasText: tagName })).toHaveCount(untagged);
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();

    // Nothing is untagged any more, which is the write landing.
    await modeSelect(page).selectOption('untagged');
    await expect(campaignList(page)).toHaveCount(0);

    // Filter by the new tag: the list and the dashboard tile agree, and the
    // campaign that was already tagged is not in the set.
    await modeSelect(page).selectOption('any');
    await tagSelect(page).selectOption({ label: tagName });
    await expect(campaignList(page)).toHaveCount(untagged);
    await expect(dashboardCount(page)).toContainText(String(untagged));
    await expect(campaignList(page).filter({ hasText: tagName })).toHaveCount(untagged);

    // And the inverse filter is the complement, not an empty set.
    await modeSelect(page).selectOption('none');
    await expect(campaignList(page)).toHaveCount(CAMPAIGN_TOTAL - untagged);

    // Untagging the same set puts the campaigns back where they started.
    await modeSelect(page).selectOption('any');
    await expect(campaignList(page)).toHaveCount(untagged);
    await page.getByRole('combobox', { name: 'Bulk assignment tag' }).selectOption({ label: tagName });
    await page.getByRole('button', { name: 'Remove tag from filtered campaigns' }).click();
    await expect(campaignList(page)).toHaveCount(CAMPAIGN_TOTAL);
    await expect(campaignList(page).filter({ hasText: tagName })).toHaveCount(0);
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    await modeSelect(page).selectOption('untagged');
    await expect(campaignList(page)).toHaveCount(untagged);
  });

  test('a goto link round-trips the exact filter state through a redirect', async ({ page }) => {
    await openTags(page);
    // A filter that is not the default in any of its three fields.
    await tagSelect(page).selectOption({ label: 'Client' });
    await modeSelect(page).selectOption('none');
    await descendantsBox(page).uncheck();
    const selectedTagId = await tagSelect(page).inputValue();
    const beforeCount = await campaignList(page).count();
    expect(beforeCount).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Copyable goto link' }).click();
    await expect(page.getByRole('status')).toContainText('/go/');
    const message = (await page.getByRole('status').textContent()) ?? '';
    const path = message.slice(message.indexOf('/go/'));
    expect(path).toMatch(/^\/go\/[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);

    const response = await page.goto(path);
    // The redirect was followed to the target route, which rendered.
    expect(response?.status()).toBe(200);
    await expect(page.locator('main[data-interactive="true"]')).toBeVisible();

    const url = new URL(page.url());
    expect(url.pathname).toBe('/tags');
    expect(JSON.parse(url.searchParams.get('state') ?? 'null')).toEqual({
      tagFilter: { tagIds: [selectedTagId], mode: 'none', includeDescendants: false },
    });

    // Restored in the controls, and producing the same rows as before the link.
    await expect(modeSelect(page)).toHaveValue('none');
    await expect(tagSelect(page)).toHaveValue(selectedTagId);
    await expect(descendantsBox(page)).not.toBeChecked();
    await expect(campaignList(page)).toHaveCount(beforeCount);
  });

  test('an expired token is a 404', async ({ page }) => {
    const response = await page.goto(`/go/${EXPIRED_TOKEN}`);
    expect(response?.status()).toBe(404);
  });

  test("another tenant's token is a 404", async ({ page }) => {
    const response = await page.goto(`/go/${FOREIGN_TOKEN}`);
    expect(response?.status()).toBe(404);
  });
});
