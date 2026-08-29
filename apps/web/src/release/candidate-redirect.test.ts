import { describe, expect, it, vi } from 'vitest';
import {
  canonicalAccountRedirect,
  requestAccountRouteWithRedirects,
  type CandidateHttpResponse,
} from './candidate-redirect';

const CANDIDATE = new URL(`https://${['wizard', 'synthetic', 'ecom', 'wizards'].join('-')}.vercel.app`);
const PROFILE = '10000000-0000-4000-8000-000000000001';

function response(status: number, redirectUrl: string | null = null): CandidateHttpResponse {
  return { exitCode: 0, status, responseBody: '', redirectUrl };
}

describe('manual release-candidate redirects', () => {
  it('accepts one same-origin canonical profile redirect and requests only its relative route', async () => {
    const request = vi.fn(async (route: string) => (
      route === '/grid'
        ? response(307, `${CANDIDATE.origin}/grid?profile=${PROFILE}`)
        : { ...response(200), responseBody: '<h1>Campaigns</h1>' }
    ));

    const result = await requestAccountRouteWithRedirects({
      candidate: CANDIDATE,
      route: '/grid',
      request,
    });

    expect(request.mock.calls).toEqual([
      ['/grid'],
      [`/grid?profile=${PROFILE}`],
    ]);
    expect(result).toMatchObject({ status: 200, redirectsFollowed: 1, redirectRejected: false });
  });

  it.each([
    `https://${['foreign', 'candidate'].join('-')}.test/grid?profile=${PROFILE}`,
    `https://${['redirect', 'user'].join('-')}:${['redirect', 'password'].join('-')}@${CANDIDATE.hostname}/grid?profile=${PROFILE}`,
    `${CANDIDATE.origin}/dashboard?profile=${PROFILE}`,
    `${CANDIDATE.origin}/grid?profile=${PROFILE}&unexpected=1`,
    `${CANDIDATE.origin}/grid?profile=not-a-profile`,
    `${CANDIDATE.origin}/grid?profile=${PROFILE}#private-fragment`,
  ])('rejects a non-canonical redirect without requesting its destination', async (location) => {
    const request = vi.fn(async () => response(307, location));

    const result = await requestAccountRouteWithRedirects({
      candidate: CANDIDATE,
      route: '/grid',
      request,
    });

    expect(request).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 307, redirectsFollowed: 0, redirectRejected: true });
    expect(JSON.stringify(result)).not.toContain(location);
    expect(result).not.toHaveProperty('location');
    expect(result).not.toHaveProperty('redirectUrl');
  });

  it('preserves an existing canonical query exactly while adding profile', () => {
    const initial = `/grid?${new URLSearchParams({ entity: 'targets', from: '2026-08-01' })}`;
    const canonical = `/grid?${new URLSearchParams({
      profile: PROFILE,
      entity: 'targets',
      from: '2026-08-01',
    })}`;
    expect(canonicalAccountRedirect(
      CANDIDATE,
      initial,
      canonical,
    )).toBe(canonical);
  });

  it('bounds and rejects redirect cycles', async () => {
    const request = vi.fn(async () => response(307, `/grid?profile=${PROFILE}`));
    const result = await requestAccountRouteWithRedirects({
      candidate: CANDIDATE,
      route: '/grid',
      request,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ redirectsFollowed: 1, redirectRejected: true });
  });
});
