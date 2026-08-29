export interface CandidateHttpResponse {
  exitCode: number | null;
  status: number | null;
  responseBody: string;
  redirectUrl: string | null;
}

export interface AccountRouteResponse extends Omit<CandidateHttpResponse, 'redirectUrl'> {
  redirectsFollowed: number;
  redirectRejected: boolean;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ACCOUNT_REDIRECTS = 1;

/**
 * Account pages may canonicalize an authenticated request by adding one profile
 * id. No other origin, path, query rewrite, fragment, or redirect loop is part
 * of that contract.
 */
export function canonicalAccountRedirect(
  candidate: URL,
  initialRoute: string,
  redirectValue: string | null,
): string | null {
  if (redirectValue === null || redirectValue === '') return null;

  let initial: URL;
  let redirected: URL;
  try {
    initial = new URL(initialRoute, candidate);
    redirected = new URL(redirectValue, candidate);
  } catch {
    return null;
  }

  if (
    initial.origin !== candidate.origin
    || redirected.origin !== candidate.origin
    || redirected.username !== ''
    || redirected.password !== ''
    || redirected.pathname !== initial.pathname
    || redirected.hash !== ''
    || initial.searchParams.has('profile')
  ) {
    return null;
  }

  const profileValues = redirected.searchParams.getAll('profile');
  if (profileValues.length !== 1 || !PROFILE_ID.test(profileValues[0] ?? '')) return null;

  const expected = entriesWithoutProfile(initial.searchParams);
  const received = entriesWithoutProfile(redirected.searchParams);
  if (expected.length !== received.length) return null;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index]?.[0] !== received[index]?.[0] || expected[index]?.[1] !== received[index]?.[1]) {
      return null;
    }
  }

  return `${redirected.pathname}${redirected.search}`;
}

export async function requestAccountRouteWithRedirects(input: {
  candidate: URL;
  route: string;
  request: (route: string) => Promise<CandidateHttpResponse>;
}): Promise<AccountRouteResponse> {
  let response = await input.request(input.route);
  let redirectsFollowed = 0;
  const visited = new Set([input.route]);

  while (
    response.exitCode === 0
    && response.status !== null
    && REDIRECT_STATUS.has(response.status)
  ) {
    const nextRoute = canonicalAccountRedirect(input.candidate, input.route, response.redirectUrl);
    if (
      nextRoute === null
      || redirectsFollowed >= MAX_ACCOUNT_REDIRECTS
      || visited.has(nextRoute)
    ) {
      return accountRouteResult(response, redirectsFollowed, true);
    }

    visited.add(nextRoute);
    redirectsFollowed += 1;
    response = await input.request(nextRoute);
  }

  return accountRouteResult(response, redirectsFollowed, false);
}

function accountRouteResult(
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

function entriesWithoutProfile(params: URLSearchParams): [string, string][] {
  return [...params.entries()]
    .filter(([key]) => key !== 'profile')
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
}
