/**
 * `GET /auth/callback` — where Supabase Auth returns.
 *
 * Not to be confused with `/api/amazon/oauth/callback`: this one finishes a
 * *user* sign-in (magic link or Google) and never touches Amazon. The PKCE code
 * is exchanged server-side, which is what puts the session in an HttpOnly
 * cookie instead of the URL fragment.
 *
 * `next` is validated as a same-site path before it is used. A redirect target
 * taken from a query string without that check is an open redirect, and this is
 * exactly the URL a phishing link would target.
 */
import { NextResponse } from 'next/server';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));

  if (!supabaseConfigured()) {
    return NextResponse.redirect(new URL('/login?error=Supabase+Auth+is+not+configured', url));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/login?error=that+link+is+no+longer+valid', url));
  }

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=that+link+is+no+longer+valid', url));
  }

  return NextResponse.redirect(new URL(next, url));
}

function safeNext(value: string | null): string {
  if (!value) return '/settings/connections';
  // A single leading slash, and no scheme: `//evil.example` is a protocol
  // relative URL and would leave the site.
  if (!value.startsWith('/') || value.startsWith('//')) return '/settings/connections';
  return value;
}
