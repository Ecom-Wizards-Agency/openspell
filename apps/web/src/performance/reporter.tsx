'use client';

import { useCallback, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';
import type { ReactNode } from 'react';
import type { PerformancePathname } from './events';
import { parseBrowserPerformanceEvent, performancePathname } from './events';
import { beginRouteNavigation, routeReadyEvent } from './navigation';
import { waitForUsableRouteContent } from './readiness';
import { sendPerformanceEvent } from './transport';

export function PerformanceReporter({ revision }: { revision: string | null }): ReactNode {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The serialized value is only a change signal. It is never copied into an
  // event, mark, request body or log.
  const routeState = searchParams.toString();
  // Core Web Vitals are document-level. This value is captured once and never
  // follows later App Router paths, preventing a late INP/CLS from being
  // attributed to whichever route happens to be current when it reports.
  const documentPathname = useRef<PerformancePathname | null | undefined>(undefined);
  if (documentPathname.current === undefined && typeof window !== 'undefined') {
    documentPathname.current = performancePathname(window.location.pathname);
  }

  const reportWebVital: Parameters<typeof useReportWebVitals>[0] = useCallback((metric) => {
    if (revision === null) return;
    const event = parseBrowserPerformanceEvent({
      event: 'openspell.web_vital',
      evidence: 'diagnostic_only',
      pathname: documentPathname.current,
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
    return waitForUsableRouteContent(document, () => {
      const event = routeReadyEvent(pathname, revision);
      if (event !== null) sendPerformanceEvent(event);
    });
  }, [pathname, revision, routeState]);

  return null;
}
