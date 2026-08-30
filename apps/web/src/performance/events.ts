/**
 * The complete browser-performance wire contract.
 *
 * This is deliberately a closed schema rather than a generic analytics bag.
 * Only exact, non-parameterized operator routes and numeric measurements may
 * cross the boundary. Query strings, profile ids, labels, cookies and user
 * identifiers have no field to occupy and unknown keys fail validation.
 */

export const PERFORMANCE_PATHNAMES = [
  '/',
  '/campaigns',
  '/creative',
  '/dashboard',
  '/dayparting',
  '/experiments',
  '/grid',
  '/ngrams',
  '/optimizer',
  '/optimizer/groups',
  '/query-intelligence',
  '/recommendations',
  '/settings',
  '/settings/account',
  '/settings/connections',
  '/settings/integrations',
  '/settings/members',
  '/settings/profiles',
  '/strategy',
  '/sync-status',
  '/tags',
  '/time-machine',
] as const;

export type PerformancePathname = (typeof PERFORMANCE_PATHNAMES)[number];

export const WEB_VITAL_NAMES = ['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB'] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
const WEB_VITAL_NAVIGATIONS = [
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
] as const;
const ROUTE_NAVIGATIONS = ['initial', 'spa', 'history'] as const;
const REVISION = /^[0-9a-f]{40}$/;
const MAX_DURATION_MS = 300_000;

export interface RouteReadyEvent {
  event: 'openspell.route_ready';
  evidence: 'diagnostic_only';
  pathname: PerformancePathname;
  revision: string;
  duration_ms: number;
  navigation_type: (typeof ROUTE_NAVIGATIONS)[number];
}

export interface WebVitalEvent {
  event: 'openspell.web_vital';
  evidence: 'diagnostic_only';
  pathname: PerformancePathname;
  revision: string;
  metric: WebVitalName;
  value: number;
  rating: (typeof WEB_VITAL_RATINGS)[number];
  navigation_type: (typeof WEB_VITAL_NAVIGATIONS)[number];
}

export type BrowserPerformanceEvent = RouteReadyEvent | WebVitalEvent;

export function parseBrowserPerformanceEvent(value: unknown): BrowserPerformanceEvent | null {
  if (!isRecord(value) || !hasExactKeysForKnownEvent(value)) return null;
  if (value['evidence'] !== 'diagnostic_only') return null;
  const pathname = performancePathname(value['pathname']);
  const revision = exactRevision(value['revision']);
  if (pathname === null || revision === null) return null;

  if (value['event'] === 'openspell.route_ready') {
    const duration = boundedNumber(value['duration_ms']);
    if (duration === null || !includes(ROUTE_NAVIGATIONS, value['navigation_type'])) return null;
    return {
      event: 'openspell.route_ready',
      evidence: 'diagnostic_only',
      pathname,
      revision,
      duration_ms: duration,
      navigation_type: value['navigation_type'],
    };
  }

  const metricValue = boundedNumber(value['value']);
  if (
    metricValue === null
    || !includes(WEB_VITAL_NAMES, value['metric'])
    || !includes(WEB_VITAL_RATINGS, value['rating'])
    || !includes(WEB_VITAL_NAVIGATIONS, value['navigation_type'])
  ) {
    return null;
  }
  return {
    event: 'openspell.web_vital',
    evidence: 'diagnostic_only',
    pathname,
    revision,
    metric: value['metric'],
    value: metricValue,
    rating: value['rating'],
    navigation_type: value['navigation_type'],
  };
}

export function performancePathname(value: unknown): PerformancePathname | null {
  return includes(PERFORMANCE_PATHNAMES, value) ? value : null;
}

export function exactRevision(value: unknown): string | null {
  return typeof value === 'string' && REVISION.test(value) ? value : null;
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_DURATION_MS
    ? Math.round(value * 100) / 100
    : null;
}

function hasExactKeysForKnownEvent(value: Record<string, unknown>): boolean {
  const expected = value['event'] === 'openspell.route_ready'
    ? ['duration_ms', 'event', 'evidence', 'navigation_type', 'pathname', 'revision']
    : value['event'] === 'openspell.web_vital'
      ? ['event', 'evidence', 'metric', 'navigation_type', 'pathname', 'rating', 'revision', 'value']
      : null;
  if (expected === null) return false;
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
