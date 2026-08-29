import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RosterSelectionProvider } from './roster-bulk.js';

describe('profile editor hydration gate', () => {
  it('fails closed in server HTML and exposes an explicit readiness marker', () => {
    const markup = renderToStaticMarkup(
      createElement(
        RosterSelectionProvider,
        null,
        createElement('button', { type: 'button' }, 'Change profile'),
      ),
    );

    expect(markup).toContain('data-testid="profile-editor"');
    expect(markup).toContain('data-interactive="false"');
    expect(markup).toContain('disabled=""');
  });
});
