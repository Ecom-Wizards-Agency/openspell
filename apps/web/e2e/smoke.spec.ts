/**
 * Authenticated route smoke coverage for the operator's primary surfaces.
 *
 * The production-build suite supplies a verified actor through its header
 * bridge. These checks deliberately stop at the page boundary: a heading is
 * enough to prove the route built, authenticated, reached Postgres and
 * rendered. Dataset-specific assertions belong to the feature suites.
 */
import { expect, test } from '@playwright/test';

const SURFACES = [
  { route: '/optimizer', heading: 'Campaign Optimizer' },
  { route: '/dashboard', heading: 'Dashboard' },
  { route: '/crosscheck', heading: 'Crosscheck' },
  { route: '/connect-claude', heading: 'Connect AI (MCP)' },
] as const;

test.describe.configure({ mode: 'serial' });

test('authenticated product surfaces render', async ({ page }) => {
  const rendered: string[] = [];

  for (const surface of SURFACES) {
    await page.goto(surface.route);
    await expect(page.getByRole('heading', { name: surface.heading, exact: true })).toBeVisible();
    rendered.push(new URL(page.url()).pathname);
  }

  expect(rendered).toEqual(SURFACES.map(({ route }) => route));
});
