import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FreshnessBar } from './dashboard.js';

describe('FreshnessBar', () => {
  it('renders current data as compact context with an accessible explanation', () => {
    const markup = renderToStaticMarkup(createElement(FreshnessBar, {
      assessment: {
        tone: 'good',
        headline: 'Fresh · covers through 2026-08-28.',
        details: ['Synthetic report: loaded 2 h ago, covers through 2026-08-28'],
        staleTypes: [],
        lossyTypes: [],
        coversThrough: '2026-08-28',
      },
    }));

    expect(markup).toContain('wa-freshness wa-freshness--good');
    expect(markup).toContain('Data current');
    expect(markup).toContain('Through Aug 28, 2026');
    expect(markup).toContain('Sync details');
    expect(markup).toContain('Freshness is based on completed Amazon report loads');
    expect(markup).not.toContain('wa-banner--good');
  });
});
