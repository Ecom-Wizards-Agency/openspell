import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KpiTile } from './dashboard.js';

describe('KpiTile comparison state', () => {
  it('uses one unambiguous treatment and hides a stray reference when delta is absent', () => {
    const markup = renderToStaticMarkup(
      <KpiTile
        label="ACOS"
        value={0.4}
        scale="percent"
        better="lower"
        context={{ currencyCode: 'USD' }}
        deltas={[{ caption: 'vs prior period', pct: null, reference: 1.283 }]}
      />,
    );

    expect(markup).toContain('No comparison data');
    expect(markup).not.toContain('128.3%');
    expect(markup).not.toContain('vs prior period');
  });
});
