import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DashboardLoading from './dashboard/loading';
import OptimizerLoading from './optimizer/loading';

describe('slow operator route loading states', () => {
  it.each([
    ['dashboard', DashboardLoading(), 'current account performance'],
    ['optimizer', OptimizerLoading(), 'campaigns, group settings'],
  ])('keeps %s navigation responsive without presenting fake controls', (_name, view, copy) => {
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(copy);
    expect(markup).not.toMatch(/<(button|input|select)\b/);
    expect(markup).not.toMatch(/\$\d|\d+\.\d+%/);
  });
});
