import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SubmitFeedbackForm } from './submit-form.js';

const context = {
  route: '/grid',
  profileId: null,
  appVersion: null,
  actorType: 'user' as const,
};

describe('/feedback/new typed intake', () => {
  it('locks feature entry points to feature copy and fields', () => {
    const markup = renderToStaticMarkup(
      createElement(SubmitFeedbackForm, { context, preselectedType: 'feature' }),
    );

    expect(markup).toContain('Request a feature');
    expect(markup).toContain('href="/roadmap"');
    expect(markup).not.toContain('type="radio"');
    expect(markup).not.toContain('data-testid="feedback-severity"');
  });

  it('keeps the type chooser only for an untyped direct visit', () => {
    const markup = renderToStaticMarkup(createElement(SubmitFeedbackForm, { context }));

    expect(markup.match(/type="radio"/g)).toHaveLength(2);
    expect(markup).toContain('Bug report');
    expect(markup).toContain('Feature request');
  });
});
