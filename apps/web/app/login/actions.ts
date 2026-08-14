'use server';

/**
 * Sign-in, both ways, and neither of them creates a user.
 *
 * `shouldCreateUser: false` is the whole no-public-signup policy in one flag:
 * an unknown address gets the same "check your inbox" answer as a known one and
 * no account appears. Google is the same story on Supabase's side, gated by the
 * provider's allowed domains and by the fact that a user with no `org_members`
 * row sees nothing.
 *
 * Every outcome comes back as a redirect with a message in the query, so the
 * login page stays a server component with no client state.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { supabaseConfigured, supabaseServerClient } from '../../src/auth/supabase';

export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/login?error=enter+an+email+address');
  if (!supabaseConfigured()) redirect('/login?error=Supabase+Auth+is+not+configured');

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${await origin()}/auth/callback`,
    },
  });

  // A refusal is never echoed verbatim: "user not found" would turn the login
  // form into an account-existence oracle.
  if (error) redirect('/login?error=that+link+could+not+be+sent');
  redirect('/login?sent=1');
}

export async function signInWithGoogle(): Promise<void> {
  if (!supabaseConfigured()) redirect('/login?error=Supabase+Auth+is+not+configured');

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${await origin()}/auth/callback` },
  });
  if (error || !data.url) redirect('/login?error=Google+sign-in+is+unavailable');
  redirect(data.url);
}

/** The app's own origin: configured first, request header only as a fallback. */
async function origin(): Promise<string> {
  const configured = process.env['WIZARD_ADS_APP_URL'];
  if (configured) return configured.replace(/\/$/, '');
  const list = await headers();
  const host = list.get('host') ?? 'localhost:3000';
  const proto = list.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}
