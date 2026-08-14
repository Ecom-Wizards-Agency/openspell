/**
 * `POST /auth/signout`.
 *
 * POST, not GET: a sign-out on GET can be triggered by an image tag on any
 * page on the internet, which is a nuisance attack that costs nothing to
 * prevent. The test-only session cookie is cleared too, so the e2e suite's
 * sign-out means the same thing as a real one.
 */
import { NextResponse } from 'next/server';
import { E2E_USER_COOKIE, e2eAuthEnabled } from '../../../src/auth/session';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';
import { ORG_COOKIE } from '../../../src/data/orgs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (supabaseConfigured()) {
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
  }

  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.delete(ORG_COOKIE);
  if (e2eAuthEnabled()) response.cookies.delete(E2E_USER_COOKIE);
  return response;
}
