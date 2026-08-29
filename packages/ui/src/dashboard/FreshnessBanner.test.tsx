import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FreshnessBanner } from './FreshnessBanner.js';

describe('FreshnessBanner', () => {
  it('uses a neutral routine surface and keeps the ledger explanation available', () => {
    const markup = renderToStaticMarkup(
      <FreshnessBanner
        assessment={{
          tone: 'good',
          headline: 'Fresh · covers through 2026-08-28.',
          details: ['Synthetic report: loaded 2 h ago, covers through 2026-08-28'],
          staleTypes: [],
          lossyTypes: [],
          coversThrough: '2026-08-28',
        }}
      />,
    );

    expect(markup).toContain('Data current');
    expect(markup).toContain('Through Aug 28, 2026');
    expect(markup).toContain('Sync details');
    expect(markup).toContain('completed Amazon report loads');
  });
});
