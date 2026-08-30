// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { NewExperimentForm, SearchableScopeSelector } from './form.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (match === undefined) throw new Error(`Button not found: ${label}`);
  return match;
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('experiment scope selectors', () => {
  it('selects all filtered campaigns, clears them, and keeps unknown deep-link IDs visible', () => {
    function Harness() {
      const [selected, setSelected] = useState(['campaign-missing']);
      return createElement(SearchableScopeSelector, {
        id: 'campaign-scope',
        label: 'Campaigns',
        hint: 'Optional profile scope',
        searchLabel: 'Find campaigns',
        options: [
          { id: 'campaign-a', label: 'Synthetic alpha', secondary: 'Campaign ID campaign-a', available: true },
          { id: 'campaign-b', label: 'Synthetic beta', secondary: 'Campaign ID campaign-b', available: true },
          { id: 'campaign-old', label: 'Synthetic old', secondary: 'Campaign ID campaign-old', available: false },
        ],
        selectedIds: selected,
        onChange: setSelected,
      });
    }

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(createElement(Harness)));

    expect(host.textContent).toContain('campaign-missing');
    expect(host.textContent).toContain('Not in the current sync');
    expect(host.textContent).toContain('1 selected');

    const search = host.querySelector<HTMLInputElement>('#campaign-scope-search');
    expect(search).not.toBeNull();
    act(() => {
      if (search !== null) setInputValue(search, 'beta');
    });
    expect(host.textContent).toContain('Synthetic beta');
    expect(host.textContent).not.toContain('Synthetic alpha');

    act(() => button(host, 'Select all filtered').click());
    expect(host.textContent).toContain('2 selected');

    act(() => button(host, 'Clear selection').click());
    expect(host.textContent).toContain('0 selected');
    expect(host.textContent).not.toContain('campaign-missing');
  });

  it('renders optional scope, synced product name and ASIN without an invented image', () => {
    const markup = renderToStaticMarkup(
      createElement(NewExperimentForm, {
        profiles: [{
          id: 'profile-a',
          label: 'Synthetic profile',
          currencyCode: 'USD',
          countryCode: 'US',
        }],
        selectedProfileId: 'profile-a',
        prefillName: '',
        scope: {
          campaignIds: ['campaign-a'],
          adGroupIds: [],
          targetIds: [],
          asins: ['B0TEST0001'],
          searchTerms: [],
        },
        initialScopeOptions: {
          campaigns: [{ id: 'campaign-a', name: 'Synthetic campaign', available: true }],
          products: [{
            asin: 'B0TEST0001',
            name: 'Synthetic product',
            sku: 'SKU-ONE',
            available: true,
          }],
        },
      }),
    );

    expect(markup).toContain('Scope is optional');
    expect(markup).toContain('Campaign ID campaign-a');
    expect(markup).toContain('Synthetic product');
    expect(markup).toContain('ASIN B0TEST0001');
    expect(markup).toContain('Keyword / target IDs (optional)');
    expect(markup).toContain('Search terms (optional)');
    expect(markup).not.toContain('<img');
  });
});
