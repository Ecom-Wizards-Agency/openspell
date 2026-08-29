import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GridLoading from './loading';

describe('grid route loading state', () => {
  it('shows immediate, honest feedback without pretending a partial grid is usable', () => {
    const markup = renderToStaticMarkup(GridLoading());

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Loading the complete result set');
    expect(markup).toContain('selected period, comparison window');
    expect(markup).toContain('aria-label="Grid loading state"');
    expect(markup).not.toMatch(/<(button|input|select)\b/);
  });
});
