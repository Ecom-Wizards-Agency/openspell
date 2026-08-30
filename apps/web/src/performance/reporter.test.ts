// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerformanceReporter } from './reporter';

interface TestMetric {
  name: string;
  value: number;
  rating: string;
  navigationType: string;
}

const vitals = vi.hoisted(() => ({
  callback: null as ((metric: TestMetric) => void) | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('next/web-vitals', () => ({
  useReportWebVitals: (callback: (metric: TestMetric) => void) => {
    vitals.callback = callback;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vitals.callback = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Web Vital route attribution', () => {
  it('keeps late document metrics on the initial route after an SPA path change', () => {
    window.history.replaceState(null, '', '/grid?profile=synthetic-profile&entity=targets');
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const fetch = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);

    document.body.innerHTML = '<div id="wa-main"><main>Grid ready</main></div>';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(createElement(PerformanceReporter, { revision: 'a'.repeat(40) })));

    window.history.pushState(null, '', '/dashboard?profile=another-profile');
    act(() => vitals.callback?.({
      name: 'INP',
      value: 42,
      rating: 'good',
      navigationType: 'navigate',
    }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0] ?? [];
    const event = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: 'openspell.web_vital',
      evidence: 'diagnostic_only',
      pathname: '/grid',
      metric: 'INP',
    });
    expect(JSON.stringify(event)).not.toContain('profile');
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });
});
