// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CompetitorProfileSelect } from './competitor-profile-select.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('CompetitorProfileSelect', () => {
  const profiles = [
    { id: 'us-on', label: 'Shared name', countryCode: 'US', syncEnabled: true },
    { id: 'ca-on', label: 'Shared name', countryCode: 'CA', syncEnabled: true },
    { id: 'de-off', label: 'Archived name', countryCode: 'DE', syncEnabled: false },
  ];

  it('starts with syncing profiles, keeps country codes, and can reveal the full roster', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(<CompetitorProfileSelect profiles={profiles} />));

    const select = host.querySelector('select') as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      'Select a profile',
      'Shared name · US',
      'Shared name · CA',
    ]);

    const button = host.querySelector('button') as HTMLButtonElement;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect([...select.options].map((option) => option.text)).toContain('Archived name · DE');
    expect(button.textContent).toBe('Show syncing profiles only');
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect([...select.options].map((option) => option.text)).not.toContain('Archived name · DE');
  });
});
