import type { BrowserPerformanceEvent } from './events';

const ENDPOINT = '/api/performance';

export function sendPerformanceEvent(event: BrowserPerformanceEvent): void {
  // The endpoint is intentionally cookie-free and the referrer is suppressed:
  // both can carry tenant/profile context even though the JSON schema cannot.
  void fetch(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
  }).catch(() => undefined);
}
