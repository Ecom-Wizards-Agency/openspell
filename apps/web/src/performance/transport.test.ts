import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPerformanceEvent } from './events';
import { sendPerformanceEvent } from './transport';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('performance transport privacy', () => {
  it('omits both credentials and the query-bearing document referrer', () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetch);
    const event: BrowserPerformanceEvent = {
      event: 'openspell.route_ready',
      evidence: 'diagnostic_only',
      pathname: '/grid',
      revision: 'a'.repeat(40),
      duration_ms: 10,
      navigation_type: 'spa',
    };

    sendPerformanceEvent(event);

    expect(fetch).toHaveBeenCalledWith('/api/performance', expect.objectContaining({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(event),
    }));
  });
});
