/**
 * `GET /api/amazon/oauth/start` — begin the Amazon grant.
 *
 * Admin and above only. The route mints a nonce, signs a state that binds the
 * org and the signed-in user to it, sets the nonce in a cookie, and redirects
 * to Amazon. It performs no Amazon call itself: there is nothing to call yet.
 *
 * The redirect URI is read from the environment rather than derived from the
 * request, because Amazon matches it byte for byte against the LWA app's
 * Allowed Return URLs and a value assembled from a proxied `Host` header is how
 * that check starts failing in production only.
 */
import { NextResponse } from 'next/server';
import { amazonOAuthConfig, secureCookies, stateSigningKey } from '../../../../../src/env';
import { authorize, Forbidden } from '../../../../../src/auth/roles';
import { currentUser } from '../../../../../src/auth/session';
import { database } from '../../../../../src/data/db';
import { resolveOrgContext } from '../../../../../src/data/orgs';
import { createNonce, createState, nonceCookie } from '../../../../../src/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return problem(401, 'sign in first');

  const handle = database();
  if (handle === null) return problem(503, 'the database is not configured');

  const requestedOrg = new URL(request.url).searchParams.get('org');
  const context = await resolveOrgContext(handle, user, requestedOrg);
  if (!context.active) return problem(403, 'you belong to no organisation');

  try {
    authorize(context.active.role, 'manageConnection');
  } catch (error) {
    if (error instanceof Forbidden) {
      return problem(403, 'connecting Amazon Ads requires the admin or owner role');
    }
    throw error;
  }

  let config;
  let key;
  try {
    config = amazonOAuthConfig();
    key = stateSigningKey();
  } catch (error) {
    return problem(503, error instanceof Error ? error.message : 'oauth is not configured');
  }

  const nonce = createNonce();
  const state = createState(key, { org: context.active.orgId, sub: user.id, nonce });

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    state,
  }).toString();

  const response = NextResponse.redirect(authorizeUrl.toString(), 302);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.append('Set-Cookie', nonceCookie(nonce, secureCookies()));
  return response;
}

function problem(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
