/**
 * The account in the chrome and the account in the page must be the same.
 *
 * A bare account-scoped URL used to let each page silently choose its own
 * default while the switcher displayed "All profiles" (or a different first
 * row). That is a wrong-account action risk, so this checks the complete route
 * boundary rather than the resolver in isolation.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

const ACCOUNT_SURFACES = [
  { route: '/dashboard', heading: 'Dashboard' },
  { route: '/grid?entity=campaigns', heading: 'Campaigns' },
  { route: '/optimizer', heading: 'Campaign Optimizer' },
  { route: '/creative', heading: 'Creative Performance' },
  { route: '/recommendations', heading: 'Recommendations' },
  { route: '/campaigns', heading: 'Campaign Builder' },
  { route: '/optimizer/groups', heading: 'Optimization Groups' },
] as const;

test.describe.configure({ mode: 'serial' });

test(
  'account-scoped routes canonicalize the profile and agree with the topbar',
  async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, 'admin');
    const { fixtureProfileId } = await readState();
    const verified: string[] = [];

    for (const surface of ACCOUNT_SURFACES) {
      await page.goto(surface.route);
      await expect(page.getByRole('heading', { name: surface.heading, exact: true })).toBeVisible();

      const url = new URL(page.url());
      expect(url.searchParams.get('profile')).toBe(fixtureProfileId);
      if (url.pathname === '/grid') expect(url.searchParams.get('entity')).toBe('campaigns');

      const switcher = page.getByTestId('profile-switcher');
      await expect(switcher).toBeVisible();
      await expect(switcher).not.toContainText('All profiles');
      const activeAccount = (await switcher.innerText()).split(' · ')[0]?.trim() ?? '';
      expect(activeAccount).not.toBe('');
      await expect(page.locator('#wa-main')).toContainText(activeAccount);
      verified.push(url.pathname);
    }

    expect(verified).toEqual(
      ACCOUNT_SURFACES.map(({ route }) => new URL(route, 'https://example.test').pathname),
    );
  },
);

test('an inaccessible profile id is replaced by the org-scoped active profile', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const inaccessible = '00000000-0000-4000-8000-000000000099';

  await page.goto(`/creative?profile=${inaccessible}`);
  await expect(page.getByRole('heading', { name: 'Creative Performance', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);

  const switcher = page.getByTestId('profile-switcher');
  const activeAccount = (await switcher.innerText()).split(' · ')[0]?.trim() ?? '';
  expect(activeAccount).not.toBe('');
  await expect(page.locator('#wa-main')).toContainText(activeAccount);
});

test('sidebar, date, entity, back and forward stay in one document and retain the profile', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  await page.goto(`/dashboard?profile=${fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

  await page.evaluate(() => {
    (window as Window & { __openspellDocumentMarker?: string }).__openspellDocumentMarker = 'same-document';
  });
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  const picker = page.locator('details.wa-date-range');
  await picker.locator('summary').click();
  await picker.getByRole('link', { name: 'Previous month', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?.*profile=/);
  await expect(picker).not.toHaveAttribute('open', '');
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);

  await page.locator('details.wa-navgroup').filter({ hasText: 'Analyze' }).locator('summary').click();
  await page.getByRole('link', { name: 'Data Grid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Search terms', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);

  await page.getByRole('tab', { name: 'Campaigns', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Search terms', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Search terms', exact: true })).toBeVisible();

  expect(await page.evaluate(
    () => (window as Window & { __openspellDocumentMarker?: string }).__openspellDocumentMarker,
  )).toBe('same-document');
  expect(documentRequests).toEqual([]);
});
