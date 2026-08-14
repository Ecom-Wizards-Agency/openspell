/**
 * `GET /api/amazon/oauth/callback` — Amazon comes back here.
 *
 * The order of the checks is the security of the route, so it is worth stating:
 *
 *  1. **State first, before anything is read from the query.** Signature, TTL,
 *     and the nonce against its `__Host-` cookie twin. A tampered or expired
 *     state is rejected before the authorization code is even looked at.
 *  2. **Session second.** The state says which org and which user started the
 *     flow; the live session must still be that user, and that user must still
 *     hold `manageConnection` in that org. A signed state is not a capability
 *     on its own: an admin demoted while the tab was open lands here.
 *  3. **Then, and only then, the exchange.** Server-side, with the client
 *     secret from the environment; the code and the tokens never reach the
 *     browser and never reach a log line.
 *
 * The nonce cookie is cleared on every outcome, success included: a nonce is
 * single-use, and leaving it set turns "replay is impossible" into "replay is
 * impossible until someone changes this file".
 */
import { NextResponse } from 'next/server';
import { amazonOAuthConfig, secureCookies, stateSigningKey } from '../../../../../src/env';
import { can } from '../../../../../src/auth/roles';
import { currentUser } from '../../../../../src/auth/session';
import { database } from '../../../../../src/data/db';
import { membershipFor, resolveOrgContext } from '../../../../../src/data/orgs';
import {
  clearedNonceCookie,
  nonceCookieName,
  verifyState,
} from '../../../../../src/oauth/state';
import type { StateFailure } from '../../../../../src/oauth/state';
import { completeConnection } from '../_lib/connect';
import { AmazonOAuthError, httpAmazonOAuthPort } from '../_lib/lwa';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One connection per org in v1; the label is what makes reconnect idempotent. */
const CONNECTION_LABEL = 'Amazon Ads';

const SETTINGS = '/settings/connections';

export async function GET(request: Request): Promise<Response> {
  const secure = secureCookies();
  const url = new URL(request.url);

  const cookieNonce = readCookie(request, nonceCookieName(secure));
  const verification = verifyState(
    safeKey(),
    url.searchParams.get('state'),
    cookieNonce,
  );
  if (!verification.ok) {
    return finish(secure, failure(stateMessage(verification.reason)));
  }

  const user = await currentUser();
  if (!user) return finish(secure, failure('your session ended; sign in and try again'));
  if (user.id !== verification.claims.sub) {
    return finish(secure, failure('this authorization was started by a different session'));
  }

  const handle = database();
  if (handle === null) return finish(secure, failure('the database is not configured'));

  const context = await resolveOrgContext(handle, user, verification.claims.org);
  const membership = membershipFor(context, verification.claims.org);
  if (!membership || !can(membership.role, 'manageConnection')) {
    return finish(secure, failure('you may no longer connect Amazon Ads for that organisation'));
  }

  // Amazon's own refusal (the operator declined, or the app is misconfigured).
  const amazonError = url.searchParams.get('error');
  if (amazonError) {
    const description = url.searchParams.get('error_description') ?? amazonError;
    return finish(secure, failure(`Amazon did not grant access: ${description}`));
  }

  const code = url.searchParams.get('code');
  if (!code) return finish(secure, failure('Amazon returned no authorization code'));

  let config;
  try {
    config = amazonOAuthConfig();
  } catch (error) {
    return finish(secure, failure(error instanceof Error ? error.message : 'oauth is not configured'));
  }

  try {
    const result = await completeConnection(handle, httpAmazonOAuthPort(config), {
      orgId: membership.orgId,
      userId: user.id,
      label: CONNECTION_LABEL,
      lwaClientId: config.clientId,
      scope: config.scope,
      code,
    });

    const params = new URLSearchParams({
      connected: '1',
      total: String(result.totalUpserted),
      regions: result.regions
        .filter((outcome) => outcome.error === null)
        .map((outcome) => `${outcome.region}:${outcome.upserted}`)
        .join(','),
    });
    const failed = result.regions.filter((outcome) => outcome.error !== null);
    if (failed.length > 0) {
      params.set('failed', failed.map((outcome) => outcome.region).join(','));
    }
    return finish(secure, `${SETTINGS}?${params.toString()}`);
  } catch (error) {
    const message =
      error instanceof AmazonOAuthError
        ? `${error.message}${error.detail ? ` (${error.detail})` : ''}`
        : error instanceof Error
          ? error.message
          : 'the connection failed';
    return finish(secure, failure(message));
  }
}

/** Redirect, always clearing the nonce. Never a body: the code is in the URL. */
function finish(secure: boolean, location: string): Response {
  const response = NextResponse.redirect(absolute(location), 303);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.append('Set-Cookie', clearedNonceCookie(secure));
  return response;
}

/**
 * `NextResponse.redirect` insists on an absolute URL. The base is the app's own
 * origin from the environment when it is set, and localhost otherwise; it is
 * never taken from the request, because a redirect target built from a header
 * an attacker controls is an open redirect.
 */
function absolute(path: string): string {
  const base = process.env['WIZARD_ADS_APP_URL'] || 'http://localhost:3000';
  return new URL(path, base).toString();
}

function failure(message: string): string {
  return `${SETTINGS}?${new URLSearchParams({ oauth_error: message }).toString()}`;
}

function stateMessage(reason: StateFailure): string {
  switch (reason) {
    case 'expired':
      return 'the authorization link expired (it is valid for 15 minutes); start again';
    case 'missing':
      return 'the authorization could not be verified; start again from this page';
    case 'nonce_mismatch':
      return 'the authorization was opened in a different browser session; start again';
    case 'bad_signature':
    case 'malformed':
    case 'not_yet_valid':
      return 'the authorization state was altered and was rejected; nothing was stored';
  }
}

/** The signing key, or a value that cannot verify anything. */
function safeKey(): string {
  try {
    return stateSigningKey();
  } catch {
    // 32 zero bytes: long enough to satisfy the length assertion, and no state
    // this app ever minted can verify against it.
    return '0'.repeat(32);
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0 && trimmed.slice(0, index) === name) return trimmed.slice(index + 1);
  }
  return null;
}
