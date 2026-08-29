import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileAwareBrand, profileAwareHomeHref } from './profile-aware-brand';

describe('OpenSpell brand link', () => {
  it('keeps profile context without carrying page-local filters', () => {
    expect(profileAwareHomeHref('https://example.test/grid?profile=profile-1&from=2026-08-01'))
      .toBe('/?profile=profile-1');
    expect(profileAwareHomeHref('https://example.test/dashboard')).toBe('/');
  });

  it('renders the official decorative brand mark instead of a placeholder letter', () => {
    const markup = renderToStaticMarkup(<ProfileAwareBrand />);
    expect(markup).toContain('<span aria-hidden="true" class="wa-brand-mark"></span>');
    expect(markup).toContain('OpenSpell');
  });
});
