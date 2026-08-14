import { describe, expect, it } from 'vitest';
import { describePageContext, normalizeRoute, pageContext } from './page-context';

describe('feedback page context', () => {
  it('keeps an internal path and drops anything that could leave the app', () => {
    expect(normalizeRoute('/grid?state=%7B%7D')).toBe('/grid?state=%7B%7D');
    expect(normalizeRoute('https://example.invalid/grid')).toBeNull();
    expect(normalizeRoute('//example.invalid/grid')).toBeNull();
    expect(normalizeRoute('\\\\server\\share')).toBeNull();
    expect(normalizeRoute('/grid\nX-Injected: 1')).toBeNull();
    expect(normalizeRoute(undefined)).toBeNull();
  });

  it('caps a route rather than storing whatever the browser sent', () => {
    const long = `/grid?state=${'x'.repeat(2000)}`;
    expect(normalizeRoute(long)?.length).toBe(512);
  });

  it('accepts only a uuid as the profile id', () => {
    const context = pageContext({
      route: '/settings/profiles',
      profileId: 'not-a-uuid',
      appVersion: ' 0.1.0 ',
    });
    expect(context.profileId).toBeNull();
    expect(context.appVersion).toBe('0.1.0');
    expect(context.actorType).toBe('user');

    const withProfile = pageContext({
      profileId: '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a',
      actorType: 'mcp',
    });
    expect(withProfile.profileId).toBe('8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a');
    expect(withProfile.actorType).toBe('mcp');
  });

  it('describes what will be sent, in the words the form shows', () => {
    const described = describePageContext(pageContext({ route: '/grid' }));
    expect(described).toContain('page: /grid');
    expect(described).toContain('profile: none selected');
    expect(described).toContain('version: unknown');
  });
});
