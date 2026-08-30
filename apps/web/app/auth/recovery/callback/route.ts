import { NextResponse } from 'next/server';
import { supabaseConfigured, supabaseServerClient } from '../../../../src/auth/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Complete already-issued recovery links even after new requests are disabled. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!supabaseConfigured() || !code) {
    return NextResponse.redirect(new URL('/forgot-password?error=link+is+no+longer+valid', url));
  }

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  const destination = error
    ? '/forgot-password?error=link+is+no+longer+valid'
    : '/recover-password';
  return NextResponse.redirect(new URL(destination, url));
}
