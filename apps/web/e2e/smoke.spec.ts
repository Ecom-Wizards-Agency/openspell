/**
 * Authenticated route smoke coverage for the operator's primary surfaces.
 *
 * The auth suite signs in through the same session-cookie path these guarded
 * pages use. These checks deliberately stop at the page boundary: a heading
 * is enough to prove the route authenticated, reached Postgres and rendered.
 * Dataset-specific assertions belong to the feature suites.
 */
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';

const SURFACES = [
  { route: '/optimizer', heading: 'Campaign Optimizer' },
  { route: '/dashboard', heading: 'Dashboard' },
  { route: '/strategy', heading: 'Strategy Overview' },
  { route: '/query-intelligence', heading: 'Query Intelligence' },
  { route: '/creative', heading: 'Creative Performance' },
  { route: '/dayparting', heading: 'Dayparting' },
  { route: '/crosscheck', heading: 'Crosscheck' },
  { route: '/connect-claude', heading: 'Connect AI (MCP)' },
] as const;

test.describe.configure({ mode: 'serial' });

test('authenticated product surfaces render', async ({ page }) => {
  await signIn(page, 'admin');
  const rendered: string[] = [];

  for (const surface of SURFACES) {
    await page.goto(surface.route);
    await expect(page.getByRole('heading', { name: surface.heading, exact: true })).toBeVisible();
    rendered.push(new URL(page.url()).pathname);
  }

  expect(rendered).toEqual(SURFACES.map(({ route }) => route));
});
