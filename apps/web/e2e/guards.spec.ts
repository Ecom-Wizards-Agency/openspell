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
 *     anybody; `/recommendations`, `/ngrams`, `/tags`, `/feedback` and
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

/** Every screen the nav offers. None of them may render to a stranger. */
const GUARDED = [
  '/dashboard',
  '/grid',
  '/crosscheck',
  '/optimizer',
  '/optimizer/groups',
  '/experiments',
  '/connect-claude',
  '/time-machine',
  '/recommendations',
  '/ngrams',
  '/tags',
  '/feedback',
  '/feedback/new',
  '/bugs',
  '/roadmap',
  '/settings/connections',
  '/settings/profiles',
  '/settings/members',
  '/settings/account',
  '/sync-status',
] as const;

test.describe.configure({ mode: 'serial' });

test('the index offers a way in when nobody is signed in', async ({ page }) => {
  await signOut(page);
  await page.goto('/');

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-signin')).toBeVisible();
  await expect(nav.getByTestId('nav-signout')).toHaveCount(0);
  await expect(page.getByTestId('home-signin')).toBeVisible();

  // And it is a real link, not a label: clicking it lands on the login screen.
  await nav.getByTestId('nav-signin').click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'wizard-ads' })).toBeVisible();
});

test('the index names the signed-in user and offers a way out', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/');

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-identity')).toBeVisible();
  await expect(nav.getByTestId('nav-signout')).toBeVisible();
  await expect(nav.getByTestId('nav-signin')).toHaveCount(0);
  await expect(page.getByTestId('home-signed-in')).toBeVisible();

  // The bar reaches every screen; the dashboard is the one an operator opens.
  await nav.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('every guarded screen sends an anonymous visitor to the login page', async ({ page }) => {
  // One goto per guarded route; in CI each first visit pays a dev-server
  // compile, so the loop needs more than the per-test default.
  test.setTimeout(300_000);
  await signOut(page);

  const landed: string[] = [];
  for (const route of GUARDED) {
    await page.goto(route);
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
    await page.goto(route);
    landed.push(new URL(page.url()).pathname);
  }

  // `/settings` alone redirects (to connections); everything else stays put.
  expect(landed.filter((path) => path === '/login')).toEqual([]);
  await expect(page.getByTestId('app-nav')).toBeVisible();
});

test('an unknown address is a not-found page, not a crash', async ({ page }) => {
  await signIn(page, 'admin');
  const response = await page.goto('/no-such-screen');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('app-not-found')).toBeVisible();
});
