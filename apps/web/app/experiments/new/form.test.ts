// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewExperimentForm, SearchableScopeSelector } from './form.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ unmount: () => void }> = [];

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('select value setter is unavailable');
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error('deferred promise is unavailable');
      resolvePromise(value);
    },
  };
}

const profiles = [
  { id: 'profile-a', label: 'Profile A', currencyCode: 'USD', countryCode: 'US' },
  { id: 'profile-b', label: 'Profile B', currencyCode: 'EUR', countryCode: 'DE' },
  { id: 'profile-c', label: 'Profile C', currencyCode: 'GBP', countryCode: 'GB' },
];

const initialScopeOptions = {
  campaigns: [{ id: 'campaign-a', name: 'Alpha campaign', available: true }],
  products: [{
    asin: 'B0TEST0001',
    name: 'Alpha product',
    sku: 'SKU-A',
    available: true,
  }],
};

function mountForm(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(createElement(NewExperimentForm, {
      profiles,
      selectedProfileId: 'profile-a',
      prefillName: '',
      scope: {
        campaignIds: ['campaign-a'],
        adGroupIds: ['ad-group-a'],
        targetIds: ['target-a'],
        asins: ['B0TEST0001'],
        searchTerms: ['alpha query'],
      },
      initialScopeOptions,
    }));
  });
  return host;
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
  vi.unstubAllGlobals();
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
          campaignIds: ['campaign-a', 'campaign-missing'],
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
    expect(markup).toContain('campaign-missing');
    expect(markup).toContain('Preserved from the link or manual entry');
    expect(markup).toContain('Synthetic product');
    expect(markup).toContain('ASIN B0TEST0001');
    expect(markup).toContain('Keyword / target IDs (optional)');
    expect(markup).toContain('Search terms (optional)');
    expect(markup).not.toContain('<img');
  });

  it('clears every profile-bound selection before loading replacement options', async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn(() => request.promise);
    vi.stubGlobal('fetch', fetchMock);
    const host = mountForm();

    expect(host.textContent).toContain('Alpha campaign');
    expect(host.textContent).toContain('Alpha product');
    expect(host.querySelector<HTMLInputElement>('#scope-targets')?.value).toBe('target-a');

    const profile = host.querySelector<HTMLSelectElement>('#experiment-profile');
    expect(profile).not.toBeNull();
    act(() => {
      if (profile !== null) setSelectValue(profile, 'profile-b');
    });

    expect(host.textContent).not.toContain('Alpha campaign');
    expect(host.textContent).not.toContain('Alpha product');
    expect(host.textContent).toContain('Loading synced scope options');
    expect(host.querySelector('[data-testid="scope-campaigns-selected-count"]')?.textContent).toBe(
      '0 selected',
    );
    expect(host.querySelector('[data-testid="scope-products-selected-count"]')?.textContent).toBe(
      '0 selected',
    );
    expect(host.querySelector<HTMLInputElement>('#scope-targets')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('#scope-terms')?.value).toBe('');
    expect(host.querySelector<HTMLInputElement>('#scope-ad-groups')?.value).toBe('');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="experiment-submit"]')?.disabled).toBe(
      true,
    );

    await act(async () => {
      request.resolve(
        Response.json({
          campaigns: [{ id: 'campaign-b', name: 'Beta campaign', available: true }],
          products: [{ asin: 'B0TEST0002', name: 'Beta product', sku: null, available: true }],
        }),
      );
      await request.promise;
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Beta campaign');
    expect(host.textContent).toContain('Beta product');
    expect(host.textContent).not.toContain('Alpha campaign');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="experiment-submit"]')?.disabled).toBe(
      false,
    );
  });

  it('ignores a stale profile response after a rapid second switch', async () => {
    const profileB = deferred<Response>();
    const profileC = deferred<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('profile-b')) return profileB.promise;
        if (url.includes('profile-c')) return profileC.promise;
        throw new Error(`Unexpected scope request: ${url}`);
      }),
    );
    const host = mountForm();
    const profile = host.querySelector<HTMLSelectElement>('#experiment-profile');
    expect(profile).not.toBeNull();

    act(() => {
      if (profile !== null) setSelectValue(profile, 'profile-b');
    });
    act(() => {
      if (profile !== null) setSelectValue(profile, 'profile-c');
    });

    expect(host.textContent).not.toContain('Alpha campaign');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="experiment-submit"]')?.disabled).toBe(
      true,
    );

    await act(async () => {
      profileC.resolve(
        Response.json({
          campaigns: [{ id: 'campaign-c', name: 'Gamma campaign', available: true }],
          products: [],
        }),
      );
      await profileC.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Gamma campaign');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="experiment-submit"]')?.disabled).toBe(
      false,
    );

    await act(async () => {
      profileB.resolve(
        Response.json({
          campaigns: [{ id: 'campaign-b', name: 'Late beta campaign', available: true }],
          products: [],
        }),
      );
      await profileB.promise;
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Gamma campaign');
    expect(host.textContent).not.toContain('Late beta campaign');
  });
});
