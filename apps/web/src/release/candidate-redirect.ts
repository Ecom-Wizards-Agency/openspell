export interface CandidateHttpResponse {
  exitCode: number | null;
  status: number | null;
  responseBody: string;
  rawLocation: string | null;
}

export interface AccountRouteResponse extends Omit<CandidateHttpResponse, 'rawLocation'> {
  redirectsFollowed: number;
  redirectRejected: boolean;
}

const PROFILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function canonicalAccountRedirect(
  candidate: URL,
  initialRoute: string,
  rawLocation: string,
): string | null {
  if (/[%\\#]/.test(rawLocation) || hasUnsafeCharacter(rawLocation) || rawLocation.startsWith('//')) return null;
  const initial = strictRelativeRoute(initialRoute);
  if (initial === null) return null;
  let relative = rawLocation;
  if (rawLocation.startsWith('https://')) {
    const prefix = `${candidate.origin}`;
    if (!rawLocation.startsWith(`${prefix}/`)) return null;
    relative = rawLocation.slice(prefix.length);
  }
  if (!relative.startsWith('/') || relative.startsWith('//')) return null;
  const question = relative.indexOf('?');
  const pathname = question < 0 ? relative : relative.slice(0, question);
  if (pathname !== initial.pathname || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  const rawQuery = question < 0 ? '' : relative.slice(question + 1);
  const expectedSuffix = initial.query === '' ? '' : `&${initial.query}`;
  if (!rawQuery.startsWith('profile=') || !rawQuery.endsWith(expectedSuffix)) return null;
  const profile = rawQuery.slice('profile='.length, rawQuery.length - expectedSuffix.length);
  if (!PROFILE.test(profile)) return null;
  if (rawQuery !== `profile=${profile}${expectedSuffix}`) return null;
  return relative;
}

export async function requestAccountRouteWithRedirects(input: {
  candidate: URL;
  route: string;
  request: (route: string) => Promise<CandidateHttpResponse>;
}): Promise<AccountRouteResponse> {
  const first = await input.request(input.route);
  if (!isRedirect(first.status)) return sanitized(first, 0, false);
  const destination = first.rawLocation === null
    ? null
    : canonicalAccountRedirect(input.candidate, input.route, first.rawLocation);
  if (destination === null) return sanitized(first, 0, true);
  const second = await input.request(destination);
  return sanitized(second, 1, isRedirect(second.status));
}

function strictRelativeRoute(route: string): { pathname: string; query: string } | null {
  if (!route.startsWith('/') || route.startsWith('//') || /[%\\#]/.test(route) || hasUnsafeCharacter(route)) return null;
  const question = route.indexOf('?');
  const pathname = question < 0 ? route : route.slice(0, question);
  if (pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  return { pathname, query: question < 0 ? '' : route.slice(question + 1) };
}

function hasUnsafeCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function isRedirect(status: number | null): boolean {
  return status !== null && status >= 300 && status < 400;
}

function sanitized(
  response: CandidateHttpResponse,
  redirectsFollowed: number,
  redirectRejected: boolean,
): AccountRouteResponse {
  return {
    exitCode: response.exitCode,
    status: response.status,
    responseBody: response.responseBody,
    redirectsFollowed,
    redirectRejected,
  };
}
