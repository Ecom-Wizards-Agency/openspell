/**
 * The sidebar at every desktop height: the nav scrolls inside its own box, the
 * utility footer stays pinned and never covers a link, and the icon rail keeps
 * every link reachable.
 *
 * The bug this guards (WP-208): `.wa-sidebar-main` had `min-height: 0` with no
 * overflow rule, so on a short viewport the flex algorithm shrank the nav box
 * and its rows spilled under `footer.wa-sidebar-utilities`. The footer has no
 * background, so the page looked fine while the footer took the clicks.
 * `toBeInViewport` cannot see that; `document.elementFromPoint` can, which is
 * why every occlusion claim here is a hit test at the link's own centre.
 *
 * The rail case guards the second half of the same commit: with all workflow
 * groups closed by default and the rail hiding group summaries, the links
 * inside a closed `<details>` were unreachable once the operator collapsed.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { NAV_LINKS } from '../src/ui/nav-links';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 720 tall is the height at which the fully open nav is taller than its box, so
 * that case demands a real scroll. At 1000 tall the same nav currently fits
 * (measured 730px of box against less content), so that case demands the same
 * frame rules and hit tests without pretending there is overflow to scroll.
 */
const VIEWPORTS = [
  { width: 1280, height: 720, mustScroll: true },
  { width: 1440, height: 1000, mustScroll: false },
] as const;

const CLOSED_KEY = 'openspell.nav.closed.v2';

async function openDashboard(page: Page): Promise<void> {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  await page.goto(`/dashboard?profile=${fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
}

/**
 * Force every workflow group open through the DOM, then prove all are open.
 *
 * Not by clicking: on the broken layout the footer intercepts the click on the
 * last summary, which is the bug itself, and a setup step that fails on the bug
 * hides the assertions that name it. Setting `open` fires the same `toggle`
 * event a click would, so the component's remembered state stays consistent.
 */
async function openEveryGroup(page: Page): Promise<void> {
  const groups = page.locator('details.wa-navgroup');
  const total = await groups.count();
  expect(total).toBeGreaterThan(0);
  for (let index = 0; index < total; index += 1) {
    const group = groups.nth(index);
    await group.evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    await expect(group).toHaveAttribute('open', '');
  }
  await expect(page.locator('details.wa-navgroup[open]')).toHaveCount(total);
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`no bounding box for ${String(locator)}`);
  return box;
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Whether the element at the link's own centre is the link (or something inside it). */
async function isHitAtOwnCenter(link: Locator): Promise<boolean> {
  return await link.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit !== null && (hit === element || element.contains(hit));
  });
}

for (const viewport of VIEWPORTS) {
  test(`at ${viewport.width}x${viewport.height} with every group open, only the nav scrolls and the footer covers no link`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openDashboard(page);
    await openEveryGroup(page);

    const sidebar = page.locator('aside.wa-sidebar');
    const main = page.locator('nav.wa-sidebar-main');
    const footer = page.locator('footer.wa-sidebar-utilities');
    const navLinks = main.locator('a.wa-navlink');

    // The footer is pinned inside the viewport, not pushed below it.
    const footerBox = await boxOf(footer);
    expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(viewport.height);

    // Sync status is the last workflow link, the one that lands under the
    // footer first. Scrolled into view, it must be what a click would reach.
    const syncStatus = main.getByRole('link', { name: 'Sync status', exact: true });
    await syncStatus.scrollIntoViewIfNeeded();
    expect(await isHitAtOwnCenter(syncStatus)).toBe(true);
    expect(intersects(await boxOf(syncStatus), await boxOf(footer))).toBe(false);

    // Then every other link, counted against the nav data so a link that
    // stopped rendering cannot pass by absence.
    const expected = NAV_LINKS.length - (await footer.locator('a.wa-navlink').count());
    await expect(navLinks).toHaveCount(expected);
    const verified: string[] = [];
    for (let index = 0; index < expected; index += 1) {
      const link = navLinks.nth(index);
      await link.scrollIntoViewIfNeeded();
      const linkBox = await boxOf(link);
      expect.soft(intersects(linkBox, await boxOf(footer)), `link ${index} vs footer`).toBe(false);
      expect.soft(await isHitAtOwnCenter(link), `link ${index} hit test`).toBe(true);
      verified.push((await link.getAttribute('href')) ?? '');
    }
    expect(verified).toHaveLength(expected);
    expect(await sidebar.boundingBox()).not.toBeNull();

    // The nav is the scroll container; the sidebar column itself is not.
    const metrics = await page.evaluate(() => {
      const nav = document.querySelector('nav.wa-sidebar-main');
      const aside = document.querySelector('aside.wa-sidebar');
      if (!(nav instanceof HTMLElement) || !(aside instanceof HTMLElement)) {
        throw new Error('sidebar frame missing');
      }
      const before = nav.scrollTop;
      nav.scrollTop = nav.scrollHeight;
      const scrolled = nav.scrollTop;
      nav.scrollTop = before;
      aside.scrollTop = aside.scrollHeight;
      const asideScrolled = aside.scrollTop;
      aside.scrollTop = 0;
      return {
        navOverflowY: getComputedStyle(nav).overflowY,
        navScrollHeight: nav.scrollHeight,
        navClientHeight: nav.clientHeight,
        navScrolled: scrolled,
        asideScrollHeight: aside.scrollHeight,
        asideClientHeight: aside.clientHeight,
        asideScrolled,
      };
    });
    expect(['auto', 'scroll']).toContain(metrics.navOverflowY);
    expect(metrics.asideScrollHeight).toBeLessThanOrEqual(metrics.asideClientHeight);
    expect(metrics.asideScrolled).toBe(0);
    // Overflow, when there is any, becomes a scroll of the nav and nothing else.
    expect(metrics.navScrolled > 0).toBe(metrics.navScrollHeight > metrics.navClientHeight);
    if (viewport.mustScroll) {
      expect(metrics.navScrollHeight).toBeGreaterThan(metrics.navClientHeight);
      expect(metrics.navScrolled).toBeGreaterThan(0);
    }
  });
}

test('the icon rail shows a visible link for every screen and leaves the remembered closed set alone', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: VIEWPORTS[0].width, height: VIEWPORTS[0].height });
  await openDashboard(page);

  // A stored closed set to protect: the forced-open rail must not rewrite it.
  const closedBefore = await page.evaluate((key) => window.localStorage.getItem(key), CLOSED_KEY);

  // The control is client-side; a click before hydration is a no-op, so retry
  // until the root carries the collapsed marker, clicking only while it is absent.
  const root = page.locator('html');
  const collapse = page.getByTestId('nav-collapse');
  await expect(async () => {
    if ((await root.getAttribute('data-nav-collapsed')) !== 'true') await collapse.click();
    await expect(root).toHaveAttribute('data-nav-collapsed', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await expect(collapse).toHaveAttribute('aria-pressed', 'true');

  const { fixtureProfileId } = await readState();
  const seen: string[] = [];
  for (const link of NAV_LINKS) {
    const anchor = page.locator(
      `aside.wa-sidebar a.wa-navlink[href="${link.href}?profile=${fixtureProfileId}"]`,
    );
    await expect(anchor, link.href).toBeVisible();
    seen.push(link.href);
  }
  expect(seen).toEqual(NAV_LINKS.map((link) => link.href));
  await expect(page.locator('aside.wa-sidebar a.wa-navlink')).toHaveCount(NAV_LINKS.length);

  const closedAfter = await page.evaluate((key) => window.localStorage.getItem(key), CLOSED_KEY);
  expect(closedAfter).toBe(closedBefore);
});
