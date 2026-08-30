import { describe, expect, it, vi } from 'vitest';
import {
  candidateRouteUrl,
  canonicalCandidateRedirect,
  requestCandidateRoute,
  type CandidateHttpResponse,
} from './candidate-redirect';

const CANDIDATE = new URL('https://wizard-synthetic-ecom-wizards.vercel.app');
const PROFILE = '10000000-0000-4000-8000-000000000001';
const OTHER_PROFILE = '20000000-0000-4000-8000-000000000002';

function response(status: number, rawLocation: string | null = null): CandidateHttpResponse {
  return { status, responseBody: '<!DOCTYPE html><main>Dashboard</main>', rawLocation };
}

describe('release candidate redirects', () => {
  it('adds the exact expected active profile to the initial candidate request', () => {
    expect(candidateRouteUrl(CANDIDATE, '/grid?entity=targets', PROFILE).href).toBe(
      `${CANDIDATE.origin}/grid?entity=targets&profile=${PROFILE}`,
    );
  });

  it('accepts one same-origin root redirect that retains the exact active profile', async () => {
    const destination = `${CANDIDATE.origin}/dashboard?profile=${PROFILE}`;
    const request = vi.fn(async (url: URL) => (
      url.pathname === '/' ? response(307, destination) : response(200)
    ));

    const result = await requestCandidateRoute({
      candidate: CANDIDATE,
      route: '/',
      expectedProfileId: PROFILE,
      request,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => url.href)).toEqual([
      `${CANDIDATE.origin}/?profile=${PROFILE}`,
      destination,
    ]);
    expect(result).toMatchObject({
      status: 200,
      redirectsFollowed: 1,
      redirectRejected: false,
    });
    expect(result.finalUrl?.href).toBe(destination);
    expect(result.rawLocation).toBeNull();
  });

  it.each([
    `https://foreign.invalid/dashboard?profile=${PROFILE}`,
    `${CANDIDATE.origin}/dashboard?profile=${OTHER_PROFILE}`,
    `${CANDIDATE.origin}/dashboard?profile=${PROFILE}&extra=1`,
    `${CANDIDATE.origin}/grid?profile=${PROFILE}`,
    `${CANDIDATE.origin}/dashboard?profile=${PROFILE}#fragment`,
    `${CANDIDATE.origin}/%64ashboard?profile=${PROFILE}`,
    ['//', CANDIDATE.hostname, '/dashboard?profile=', PROFILE].join(''),
  ])('rejects an unsafe or wrong-profile destination without requesting it: %s', async (location) => {
    const request = vi.fn(async () => response(307, location));

    const result = await requestCandidateRoute({
      candidate: CANDIDATE,
      route: '/',
      expectedProfileId: PROFILE,
      request,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 307,
      redirectsFollowed: 0,
      redirectRejected: true,
      finalUrl: null,
      rawLocation: null,
    });
    expect(JSON.stringify(result)).not.toContain(location);
  });

  it('preserves all original parameters while allowing canonical reordering', () => {
    const initialUrl = candidateRouteUrl(
      CANDIDATE,
      '/grid?entity=targets&from=2026-08-01',
      PROFILE,
    );
    const destination = canonicalCandidateRedirect({
      candidate: CANDIDATE,
      initialUrl,
      rawLocation: ['/grid?profile=', PROFILE, '&from=2026-08-01&entity=targets'].join(''),
      expectedProfileId: PROFILE,
    });

    expect(destination?.pathname).toBe('/grid');
    expect(destination?.searchParams.get('profile')).toBe(PROFILE);
    expect(Array.from(destination?.searchParams.keys() ?? [])).toHaveLength(3);
  });

  it('bounds redirect chains at one response transition', async () => {
    const redirect = `/dashboard?profile=${PROFILE}`;
    const request = vi.fn(async () => response(307, redirect));

    const result = await requestCandidateRoute({
      candidate: CANDIDATE,
      route: '/',
      expectedProfileId: PROFILE,
      request,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      redirectsFollowed: 1,
      redirectRejected: true,
      finalUrl: null,
    });
  });
});
