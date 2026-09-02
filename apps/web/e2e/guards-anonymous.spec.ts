/** Anonymous frame and guarded-route redirect proofs in a fresh Next process. */
import { expect, test } from '@playwright/test';
import { GUARDED_ROUTES } from '../src/e2e-guard-routes';
import { signOut } from './support/auth';

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

test('every guarded screen sends an anonymous visitor to the login page', async ({ page }) => {
  // One goto per guarded route; in CI each first visit pays a dev-server
  // compile, so the loop needs more than the per-test default.
  test.setTimeout(300_000);
  await signOut(page);

  const landed: string[] = [];
  for (const { path } of GUARDED_ROUTES) {
    // A server-component `redirect()` can commit `/login` quickly enough to
    // interrupt Playwright's wait for the original document. That is the
    // protected outcome we want, so wait for the destination explicitly while
    // still surfacing every other navigation failure.
    await page.goto(path).catch((error: unknown) => {
      if (!String(error).includes('is interrupted by another navigation')) throw error;
    });
    await page.waitForURL('**/login');
    landed.push(new URL(page.url()).pathname);
  }

  // Counted against the input rather than asserted one at a time, so a route
  // that silently stops redirecting cannot hide in a passing run.
  expect(landed).toEqual(GUARDED_ROUTES.map(() => '/login'));
});
