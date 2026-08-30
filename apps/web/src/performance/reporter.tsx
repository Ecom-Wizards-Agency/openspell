'use client';

import { useCallback, useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import type { ReactNode } from 'react';
import type { BrowserPerformanceEvent } from './events';
import { parseBrowserPerformanceEvent } from './events';
import { beginRouteNavigation, routeReadyEvent } from './navigation';

const ENDPOINT = '/api/performance';

export function PerformanceReporter({ revision }: { revision: string | null }): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The serialized value is only a change signal. It is never copied into an
  // event, mark, request body or log.
  const routeState = searchParams.toString();

  const reportWebVital: Parameters<typeof useReportWebVitals>[0] = useCallback((metric) => {
    if (revision === null) return;
    const event = parseBrowserPerformanceEvent({
      event: 'openspell.web_vital',
      pathname: window.location.pathname,
      revision,
      metric: metric.name,
      value: metric.value,
      rating: metric.rating,
      navigation_type: metric.navigationType,
    });
    if (event !== null) sendPerformanceEvent(event);
  }, [revision]);
  useReportWebVitals(reportWebVital);

  useEffect(() => {
    const onHistory = (): void => beginRouteNavigation('history');
    window.addEventListener('popstate', onHistory);
    return () => window.removeEventListener('popstate', onHistory);
  }, []);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const event = routeReadyEvent(pathname, revision);
        if (event !== null) sendPerformanceEvent(event);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [pathname, revision, routeState]);

  return null;
}

export function sendPerformanceEvent(event: BrowserPerformanceEvent): void {
  // `credentials: omit` is intentional: even the transport carries no session
  // cookie. The server accepts only the closed event schema above.
  void fetch(ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(event),
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    keepalive: true,
  }).catch(() => undefined);
}
