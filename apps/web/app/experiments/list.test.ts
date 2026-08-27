import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProposedTestsSection } from './list.js';

describe('/experiments proposed tests', () => {
  it('renders selected proposals without creating an experiment action', () => {
    const markup = renderToStaticMarkup(
      createElement(ProposedTestsSection, {
        proposedTests: [
          {
            hypothesis: 'A synthetic structure improves durable rank.',
            method: 'Run a controlled synthetic comparison.',
            successMetric: 'Rank delta and ACOS.',
            source: 'synthetic#test',
            status: 'vetted_backlog',
            priority: 'high',
          },
        ],
      }),
    );

    expect(markup).toContain('Proposed tests');
    expect(markup).toContain('A synthetic structure improves durable rank.');
    expect(markup).toContain('proposals only');
    expect(markup).not.toContain('Create experiment');
  });

  it('states the valid empty result', () => {
    const markup = renderToStaticMarkup(createElement(ProposedTestsSection, { proposedTests: [] }));
    expect(markup).toContain('No new tests warranted for the current signals.');
  });
});
