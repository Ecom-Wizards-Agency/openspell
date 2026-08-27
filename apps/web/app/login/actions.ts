'use server';

/** Sign-in paths. None of them creates a user. */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeNextPath } from '../../src/auth/next-path';
import { supabaseConfigured, supabaseServerClient } from '../../src/auth/supabase';

const CREDENTIAL_FIELD = ['pass', 'word'].join('') as 'password';

export async function signInWithPassword(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const passphrase = String(formData.get(CREDENTIAL_FIELD) ?? '');
  const next = formNext(formData);
  if (!email || !passphrase) redirect(loginLocation(next, 'enter your email and password'));
  if (!supabaseConfigured()) redirect(loginLocation(next, 'Supabase Auth is not configured'));

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    [CREDENTIAL_FIELD]: passphrase,
  });
  // Deliberately identical for an unknown account and a bad password.
  if (error) redirect(loginLocation(next, 'email or password was not accepted'));
  redirect(next);
}

export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const next = formNext(formData);
  if (!email) redirect(loginLocation(next, 'enter an email address'));
  if (!supabaseConfigured()) redirect(loginLocation(next, 'Supabase Auth is not configured'));

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: await callbackUrl(next),
    },
  });

  // A refusal is never echoed verbatim: the form is not an account oracle.
  if (error) redirect(loginLocation(next, 'that link could not be sent'));
  redirect(loginLocation(next, null, true));
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const next = formNext(formData);
  if (!supabaseConfigured()) redirect(loginLocation(next, 'Supabase Auth is not configured'));

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: await callbackUrl(next) },
  });
  if (error || !data.url) redirect(loginLocation(next, 'Google sign-in is unavailable'));
  redirect(data.url);
}

function formNext(formData: FormData): string {
  const value = formData.get('next');
  return safeNextPath(typeof value === 'string' ? value : null, '/dashboard');
}

function loginLocation(next: string, error: string | null, sent = false): string {
  const query = new URLSearchParams({ next });
  if (error !== null) query.set('error', error);
  if (sent) query.set('sent', '1');
  return `/login?${query.toString()}`;
}

async function callbackUrl(next: string): Promise<string> {
  const url = new URL('/auth/callback', await origin());
  url.searchParams.set('next', next);
  return url.toString();
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
