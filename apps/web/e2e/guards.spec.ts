/**
 * The way in, and the door on every other room.
 *
 * Two failures found in production, checked here from the browser because both
 * were invisible to every unit test that existed:
 *
 *  1. **There was no login option.** No nav, no sign-in link anywhere; `/login`
 *     was reachable only by typing it. So the first two tests assert the frame
 *     itself — the bar, and what it offers in each session state.
 *  2. **Half the product was unguarded and the other half printed its refusal.**
 *     `/dashboard`, `/grid` and `/crosscheck` rendered a tenant's numbers to
 *     anybody; `/recommendations`, `/ngrams`, `/tags`, `/bugs` and
 *     `/roadmap` answered "Authentication required" with an HTTP 200. Both are
 *     now the same thing: a redirect to `/login`.
 *
 * This suite runs against `next dev` with the real session cookie path, which is
 * the only place in the repository where "anonymous" is a state the application
 * can actually be in — the WP-08 suite arms the header bridge, so every request
 * there arrives already authenticated.
 */
import { expect, test } from '@playwright/test';
import { signIn, signOut } from './support/auth';
import { readState } from './support/fixture';

/** Every screen the nav offers. None of them may render to a stranger. */
const GUARDED = [
  '/dashboard',
  '/grid',
  '/crosscheck',
  '/optimizer',
  '/optimizer/groups',
  '/strategy',
  '/query-intelligence',
  '/creative',
  '/dayparting',
  '/experiments',
  '/connect-claude',
  '/time-machine',
  '/recommendations',
  '/campaigns',
  '/ngrams',
  '/tags',
  '/feedback/new',
  '/bugs',
  '/roadmap',
  '/settings/connections',
  '/settings/integrations',
  '/settings/profiles',
  '/settings/members',
  '/settings/account',
  '/sync-status',
] as const;

const PROFILE_CANONICAL = new Set([
  '/dashboard',
  '/grid',
  '/optimizer',
  '/optimizer/groups',
  '/recommendations',
  '/campaigns',
  '/creative',
]);

const AUTHENTICATED_REDIRECTS = new Map([
  [
    '/strategy',
    {
      pathname: '/dashboard',
      hash: '#operating-status',
      profile: true,
      artifact: '#operating-status',
    },
  ],
]);

/** Primary data-backed routes whose artifact, not only URL, must render. */
const PRODUCT_HEADINGS = new Map<string, string>([
  ['/optimizer', 'Campaign Optimizer'],
  ['/dashboard', 'Dashboard'],
  ['/query-intelligence', 'Query Intelligence'],
  ['/creative', 'Creative Performance'],
  ['/dayparting', 'Dayparting'],
  ['/crosscheck', 'Crosscheck'],
  ['/connect-claude', 'Connect AI (MCP)'],
]);

test.describe.configure({ mode: 'serial' });

test('the index sends an anonymous visitor directly to sign in', async ({ page }) => {
  await signOut(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-signin')).toBeVisible();
  await expect(nav.getByTestId('nav-signout')).toHaveCount(0);
  await expect(nav.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(page.getByTestId('feedback-entry')).toHaveCount(0);
  await expect(page.getByTestId('home-signin')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'OpenSpell' })).toBeVisible();
});

test('the index opens the signed-in operator dashboard with its active profile', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/');
  const { fixtureProfileId } = await readState();

  await page.waitForURL((url) =>
    url.pathname === '/dashboard' && url.searchParams.get('profile') === fixtureProfileId,
  );
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-identity')).toBeVisible();
  // The way out lives inside the avatar menu since the design system pass.
  await nav.getByTestId('nav-identity').locator('summary').click();
  await expect(nav.getByTestId('nav-signout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav.getByTestId('nav-signin')).toHaveCount(0);
  await expect(page.getByTestId('home-signed-in')).toHaveCount(0);
  await expect(page.getByTestId('feedback-entry')).toBeVisible();
});

test('every guarded screen sends an anonymous visitor to the login page', async ({ page }) => {
  // One goto per guarded route; in CI each first visit pays a dev-server
  // compile, so the loop needs more than the per-test default.
  test.setTimeout(300_000);
  await signOut(page);

  const landed: string[] = [];
  for (const route of GUARDED) {
    // A server-component `redirect()` can commit `/login` quickly enough to
    // interrupt Playwright's wait for the original document. That is the
    // protected outcome we want, so wait for the destination explicitly while
    // still surfacing every other navigation failure.
    await page.goto(route).catch((error: unknown) => {
      if (!String(error).includes('is interrupted by another navigation')) throw error;
    });
    await page.waitForURL('**/login');
    landed.push(new URL(page.url()).pathname);
  }

  // Counted against the input rather than asserted one at a time, so a route
  // that silently stops redirecting cannot hide in a passing run.
  expect(landed).toEqual(GUARDED.map(() => '/login'));
});

test('the same screens open once there is a session', async ({ page }) => {
  test.setTimeout(300_000); // same routes, same CI compile cost as above
  await signIn(page, 'admin');

  const landed: string[] = [];
  for (const route of GUARDED) {
    const expectedPath = new URL(route, 'https://example.test').pathname;
    const expectedRedirect = AUTHENTICATED_REDIRECTS.get(expectedPath);
    await page.goto(route).catch((error: unknown) => {
      const expectedFollowUp = PROFILE_CANONICAL.has(expectedPath) || expectedRedirect !== undefined;
      if (!expectedFollowUp || !String(error).includes('is interrupted by')) {
        throw error;
      }
    });
    if (PROFILE_CANONICAL.has(expectedPath)) {
      await page.waitForURL(
        (url) => url.pathname === expectedPath && url.searchParams.has('profile'),
      );
    } else if (expectedRedirect !== undefined) {
      await page.waitForURL(
        (url) => (
          url.pathname === expectedRedirect.pathname
          && url.hash === expectedRedirect.hash
          && (!expectedRedirect.profile || url.searchParams.has('profile'))
        ),
      );
      await expect(page.locator(expectedRedirect.artifact)).toBeVisible();
    }
    const expectedHeading = PRODUCT_HEADINGS.get(expectedPath);
    if (expectedHeading !== undefined) {
      await expect(page.getByRole('heading', { name: expectedHeading, exact: true })).toBeVisible();
    }
    landed.push(new URL(page.url()).pathname);
  }

  // Strategy Overview now lives inside Dashboard. Assert that one intentional
  // redirect exactly; every other route must stay on its requested pathname.
  expect(landed).toEqual(GUARDED.map((route) => (
    AUTHENTICATED_REDIRECTS.get(route)?.pathname ?? route
  )));
  await expect(page.getByTestId('app-nav')).toBeVisible();
});

test('an unknown address is a not-found page, not a crash', async ({ page }) => {
  await signIn(page, 'admin');
  const response = await page.goto('/no-such-screen');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('app-not-found')).toBeVisible();
});
