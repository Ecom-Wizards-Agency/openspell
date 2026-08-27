/**
 * The nav renders, in both states, and says the one thing it exists to say.
 *
 * The bug this covers was not subtle — the deployed product had no visible way
 * to sign in at all — so the assertions are the blunt ones: every screen is
 * reachable from the bar, an anonymous visitor is offered `/login`, and a
 * signed-in one is told who they are and offered a way out. `NavBar` is pure
 * precisely so this can be checked without a request.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_LINKS, NavBar } from './nav.js';
import { profileAwareHomeHref } from './profile-aware-brand.js';

const render = (user: { id: string; email: string | null } | null): string =>
  renderToStaticMarkup(createElement(NavBar, { user }));

describe('the application nav', () => {
  it('links every screen, signed in or not', () => {
    for (const markup of [render(null), render({ id: 'u-1', email: 'a@example.test' })]) {
      for (const link of NAV_LINKS) {
        expect(markup).toContain(`href="${link.href}"`);
        expect(markup).toContain(link.label);
      }
      // Counted against the input rather than spot-checked.
      expect(markup.match(/<a /g)?.length).toBeGreaterThanOrEqual(NAV_LINKS.length);
    }
  });

  it('offers a sign-in to an anonymous visitor, and only that', () => {
    const markup = render(null);
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('Sign in');
    expect(markup).not.toContain('/auth/signout');
    expect(markup).not.toContain('signed in as');
  });

  it('names the signed-in user and offers a way out', () => {
    const markup = render({ id: 'u-1', email: 'operator@example.test' });
    expect(markup).toContain('signed in as');
    expect(markup).toContain('operator@example.test');
    expect(markup).toContain('action="/auth/signout"');
    expect(markup).toContain('sign out');
    // No second, contradictory affordance.
    expect(markup).not.toContain('href="/login"');
  });

  it('still offers a way out when the session carries no address', () => {
    const markup = render({ id: 'u-1', email: null });
    expect(markup).toContain('signed in as your account');
    expect(markup).toContain('action="/auth/signout"');
  });

  it('keeps only the selected profile when the brand link returns home', () => {
    expect(profileAwareHomeHref('https://app.example.test/grid?profile=p-1&from=2026-08-01')).toBe(
      '/?profile=p-1',
    );
    expect(profileAwareHomeHref('https://app.example.test/grid?from=2026-08-01')).toBe('/');
  });
});
