export interface CandidateHttpResponse {
  status: number | null;
  responseBody: string;
  rawLocation: string | null;
}

export interface CandidateRouteResponse extends CandidateHttpResponse {
  finalUrl: URL | null;
  redirectsFollowed: number;
  redirectRejected: boolean;
}

interface CandidateRouteRequest {
  candidate: URL;
  route: string;
  expectedProfileId: string;
  request: (url: URL) => Promise<CandidateHttpResponse>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Request one candidate route without giving curl redirect authority. A route
 * may make one canonical same-origin redirect, and that redirect must retain
 * the exact active profile selected in the operator's existing browser.
 */
export async function requestCandidateRoute(
  input: CandidateRouteRequest,
): Promise<CandidateRouteResponse> {
  const initialUrl = candidateRouteUrl(input.candidate, input.route, input.expectedProfileId);
  const first = await input.request(initialUrl);
  if (!isRedirect(first.status)) return result(first, initialUrl, 0, false);

  const destination = first.rawLocation === null
    ? null
    : canonicalCandidateRedirect({
        candidate: input.candidate,
        initialUrl,
        rawLocation: first.rawLocation,
        expectedProfileId: input.expectedProfileId,
      });
  if (destination === null) return result(first, null, 0, true);

  const second = await input.request(destination);
  if (isRedirect(second.status)) return result(second, null, 1, true);
  return result(second, destination, 1, false);
}

export function candidateRouteUrl(candidate: URL, route: string, expectedProfileId: string): URL {
  if (!UUID.test(expectedProfileId)) throw new Error('invalid_expected_profile');
  if (!isStrictRelativeRoute(route)) throw new Error('invalid_candidate_route');

  const url = new URL(route, candidate.origin);
  if (url.origin !== candidate.origin || url.hash !== '') throw new Error('invalid_candidate_route');
  const suppliedProfiles = url.searchParams.getAll('profile');
  if (suppliedProfiles.length > 1) throw new Error('invalid_candidate_route');
  if (suppliedProfiles[0] !== undefined && suppliedProfiles[0] !== expectedProfileId) {
    throw new Error('invalid_candidate_route');
  }
  url.searchParams.set('profile', expectedProfileId);
  return url;
}

export function canonicalCandidateRedirect(input: {
  candidate: URL;
  initialUrl: URL;
  rawLocation: string;
  expectedProfileId: string;
}): URL | null {
  if (
    !UUID.test(input.expectedProfileId)
    || hasUnsafeCharacter(input.rawLocation)
    || input.rawLocation.includes('%')
    || input.rawLocation.includes('\\')
    || input.rawLocation.includes('#')
    || input.rawLocation.startsWith('//')
  ) {
    return null;
  }

  let destination: URL;
  try {
    destination = new URL(input.rawLocation, input.initialUrl);
  } catch {
    return null;
  }

  const expectedPath = input.initialUrl.pathname === '/'
    ? '/dashboard'
    : input.initialUrl.pathname;
  if (
    destination.protocol !== 'https:'
    || destination.origin !== input.candidate.origin
    || destination.username !== ''
    || destination.password !== ''
    || destination.hash !== ''
    || destination.pathname !== expectedPath
  ) {
    return null;
  }

  const profiles = destination.searchParams.getAll('profile');
  if (profiles.length !== 1 || profiles[0] !== input.expectedProfileId) return null;
  if (!sameSearchParams(input.initialUrl.searchParams, destination.searchParams)) return null;
  return destination;
}

function sameSearchParams(initial: URLSearchParams, destination: URLSearchParams): boolean {
  const normalized = (params: URLSearchParams): string[] => Array.from(params.entries())
    .map(([key, value]) => `${key}\u0000${value}`)
    .sort();
  const expected = normalized(initial);
  const observed = normalized(destination);
  return expected.length === observed.length
    && expected.every((value, index) => value === observed[index]);
}

function isStrictRelativeRoute(route: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//') || hasUnsafeCharacter(route)) return false;
  if (route.includes('%') || route.includes('\\') || route.includes('#')) return false;
  const rawPath = route.split('?')[0] ?? '';
  if (rawPath.split('/').some((part) => part === '.' || part === '..')) return false;
  const url = new URL(route, 'https://candidate.invalid');
  return url.origin === 'https://candidate.invalid';
}

function isRedirect(status: number | null): boolean {
  return status !== null && status >= 300 && status < 400;
}

function hasUnsafeCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function result(
  response: CandidateHttpResponse,
  finalUrl: URL | null,
  redirectsFollowed: number,
  redirectRejected: boolean,
): CandidateRouteResponse {
  return {
    status: response.status,
    responseBody: response.responseBody,
    rawLocation: null,
    finalUrl,
    redirectsFollowed,
    redirectRejected,
  };
}
