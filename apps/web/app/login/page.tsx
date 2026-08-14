/**
 * `/login` — a magic link or Google, and nothing else.
 *
 * No signup form, because there is no signup: users are invited or seeded into
 * `org_members`. The page says that out loud rather than leaving someone
 * hunting for a "create account" link that will never exist.
 */
import type { ReactNode } from 'react';
import { currentUser } from '../../src/auth/session';
import { supabaseConfigured } from '../../src/auth/supabase';
import { banner, colors, heading, muted, page } from '../../src/ui/tokens';
import { sendMagicLink, signInWithGoogle } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}): Promise<ReactNode> {
  const { error, sent } = await searchParams;
  const user = await currentUser();

  return (
    <main style={{ ...page, maxWidth: '28rem' }}>
      <h1 style={heading}>wizard-ads</h1>
      <p style={muted}>
        Sign in with your work address. There is no public signup: accounts are created by
        invitation, so an address that is not already a member will not receive a link.
      </p>

      {error ? <p style={banner('bad')}>{error}</p> : null}
      {sent ? (
        <p style={banner('good')} data-testid="magic-link-sent">
          If that address belongs to a member, a sign-in link is on its way.
        </p>
      ) : null}
      {user ? (
        <p style={banner('good')}>
          You are already signed in. <a href="/settings/connections">Continue</a>.
        </p>
      ) : null}

      {supabaseConfigured() ? (
        <>
          <form action={sendMagicLink} style={{ display: 'grid', gap: '0.5rem' }}>
            <label htmlFor="email" style={{ fontSize: '0.875rem' }}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: '0.25rem',
                padding: '0.5rem',
              }}
            />
            <button type="submit">Email me a sign-in link</button>
          </form>

          <form action={signInWithGoogle} style={{ marginTop: '1rem' }}>
            <button type="submit">Continue with Google</button>
          </form>
        </>
      ) : (
        <p style={banner('warn')}>
          Supabase Auth is not configured on this instance. Set{' '}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>;
          see <code>apps/web/env.TEMPLATE</code>.
        </p>
      )}
    </main>
  );
}
