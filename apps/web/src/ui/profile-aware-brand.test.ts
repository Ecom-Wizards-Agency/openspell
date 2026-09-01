import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RELEASE_ARTIFACT } from './artifact-markers';
import { ProfileAwareBrand, profileAwareHomeHref } from './profile-aware-brand';

describe('OpenSpell brand link', () => {
  it('keeps profile context without carrying page-local filters', () => {
    expect(profileAwareHomeHref('https://example.test/grid?profile=profile-1&from=2026-08-01'))
      .toBe('/?profile=profile-1');
    expect(profileAwareHomeHref('https://example.test/dashboard')).toBe('/');
  });

  it('renders the versioned real brand mark and binds its tracked asset bytes', () => {
    const markup = renderToStaticMarkup(createElement(ProfileAwareBrand));
    const stylesheet = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
    const asset = readFileSync(
      new URL('../../public/brand/wizards-ai-icon.svg', import.meta.url),
    );

    expect(markup).toContain('class="wa-brand-mark"');
    expect(markup).toContain(`data-release-artifact="${RELEASE_ARTIFACT.brandMark}"`);
    expect(markup).toContain('OpenSpell');
    expect(stylesheet).toMatch(
      /\.wa-brand-mark\s*\{[^}]*url\('\/brand\/wizards-ai-icon\.svg'\)/s,
    );
    expect(createHash('sha256').update(asset).digest('hex')).toBe(
      'ec87eb73689b1792fabd9c7098b03f7b7c86f4192ced9c9ad63a64ab85ed0a55',
    );
  });
});
