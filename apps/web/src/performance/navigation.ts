'use client';

import type { RouteReadyEvent } from './events';
import { exactRevision, performancePathname } from './events';

type NavigationKind = RouteReadyEvent['navigation_type'];

interface PendingNavigation {
  kind: NavigationKind;
  startedAt: number;
}

let pending: PendingNavigation | null = null;

/** Called immediately before an App Router transition starts. */
export function beginRouteNavigation(kind: Exclude<NavigationKind, 'initial'> = 'spa'): void {
  if (typeof performance === 'undefined') return;
  pending = { kind, startedAt: performance.now() };
  performance.clearMarks('openspell.route-start');
  performance.mark('openspell.route-start');
}

/** Called after the destination commit is paintable; consumes one pending transition. */
export function routeReadyEvent(pathname: string, revision: string | null): RouteReadyEvent | null {
  if (typeof performance === 'undefined') return null;
  const sanitizedPathname = performancePathname(pathname);
  if (sanitizedPathname === null) return null;

  const navigation = pending ?? { kind: 'initial' as const, startedAt: 0 };
  pending = null;
  const duration = Math.max(0, performance.now() - navigation.startedAt);
  performance.clearMarks('openspell.route-ready');
  performance.mark('openspell.route-ready');
  // Local and preview builds still expose the mark for a trace, but no event
  // leaves the browser unless it can be attributed to an exact revision.
  const attributedRevision = exactRevision(revision);
  if (attributedRevision === null) return null;
  return {
    event: 'openspell.route_ready',
    pathname: sanitizedPathname,
    revision: attributedRevision,
    duration_ms: duration,
    navigation_type: navigation.kind,
  };
}
