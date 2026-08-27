import { describe, expect, it } from 'vitest';
import { buildBugWidgetPayload } from './bug-form.js';

describe('bug widget payload', () => {
  it('is always a bug and derives title, body, and profile from the captured route', () => {
    const profileId = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
    expect(
      buildBugWidgetPayload({
        text: '  Export loses its sort  \nIt happens after filtering by spend.\nEvery time.',
        severity: 'high',
        route: `/grid?profile=${profileId}&from=2026-08-01`,
        appVersion: '0.2.0',
      }),
    ).toEqual({
      type: 'bug',
      title: 'Export loses its sort',
      body: 'It happens after filtering by spend.\nEvery time.',
      severity: 'high',
      pageContext: {
        route: `/grid?profile=${profileId}&from=2026-08-01`,
        profileId,
        appVersion: '0.2.0',
      },
    });
  });

  it('requires a bounded first-line title', () => {
    expect(() =>
      buildBugWidgetPayload({ text: '\nOnly a body', severity: 'low', route: '/', appVersion: null }),
    ).toThrow(/first line/i);
    expect(() =>
      buildBugWidgetPayload({
        text: 'x'.repeat(201),
        severity: 'low',
        route: '/',
        appVersion: null,
      }),
    ).toThrow(/200/);
  });
});
