/**
 * The nav renders, in both states, and says the one thing it exists to say.
 *
 * The bug this covers was not subtle — the deployed product had no visible way
 * to sign in at all — so the assertions are the blunt ones: every screen is
 * reachable after sign-in, an anonymous visitor gets only the public header,
 * and a signed-in one is told who they are and offered a way out. `NavBar` is
 * pure precisely so this can be checked without a request.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NAV_LINKS, NavBar } from './nav.js';
import { userInitials } from './topbar-controls.js';
import { profileAwareHomeHref } from './profile-aware-brand.js';

const render = (user: { id: string; email: string | null } | null): string =>
  renderToStaticMarkup(createElement(NavBar, { user }));

describe('the application nav', () => {
  it('links every operator screen after sign-in', () => {
    const markup = render({ id: 'u-1', email: 'a@example.test' });
    for (const link of NAV_LINKS) {
      expect(markup).toContain(`href="${link.href}"`);
      expect(markup).toContain(link.label);
    }
    // Counted against the input rather than spot-checked.
    expect(markup.match(/<a /g)?.length).toBeGreaterThanOrEqual(NAV_LINKS.length);
  });

  it('offers a quiet public header to an anonymous visitor', () => {
    const markup = render(null);
    expect(markup).toContain('data-auth-state="anonymous"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('Sign in');
    expect(markup).not.toContain('aria-label="Primary"');
    expect(markup).not.toContain('class="wa-sidebar"');
    expect(markup).not.toContain('>Dashboard<');
    expect(markup).not.toContain('/auth/signout');
    expect(markup).not.toContain('data-testid="nav-identity"');
  });

  it('keeps identity details inside an avatar menu and offers a way out', () => {
    const markup = render({ id: 'u-1', email: 'operator@example.test' });
    expect(markup).toContain('data-testid="nav-identity"');
    expect(markup).toContain('>OP<');
    expect(markup).toContain('operator@example.test');
    expect(markup).toContain('action="/auth/signout"');
    expect(markup).toContain('Sign out');
    // No second, contradictory affordance.
    expect(markup).not.toContain('href="/login"');
  });

  it('still offers a way out when the session carries no address', () => {
    const markup = render({ id: 'u-1', email: null });
    expect(markup).toContain('>WA<');
    expect(markup).toContain('your account');
    expect(markup).toContain('action="/auth/signout"');
  });

  it('derives stable avatar initials without exposing the address in the trigger', () => {
    expect(userInitials('victor.uhl@example.test')).toBe('VU');
    expect(userInitials('operator@example.test')).toBe('OP');
    expect(userInitials(null)).toBe('WA');
  });

  it('keeps only the selected profile when the brand link returns home', () => {
    expect(profileAwareHomeHref('https://app.example.test/grid?profile=p-1&from=2026-08-01')).toBe(
      '/?profile=p-1',
    );
    expect(profileAwareHomeHref('https://app.example.test/grid?from=2026-08-01')).toBe('/');
  });
});
