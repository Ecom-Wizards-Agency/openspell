/** `/login` — password, magic link, or Google; never public signup. */
import type { ReactNode } from 'react';
import { authFeatureConfig } from '../../src/auth/config';
import { currentUser } from '../../src/auth/session';
import { safeNextPath } from '../../src/auth/next-path';
import { supabaseConfigured } from '../../src/auth/supabase';
import { Button, Field, Input } from '../../src/ui/primitives';
import { banner, heading, muted, page } from '../../src/ui/tokens';
import { sendMagicLink, signInWithGoogle, signInWithPassword } from './actions';
import { PasskeySignIn } from './passkey-button';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string; next?: string }>;
}): Promise<ReactNode> {
  const { error, sent, next: requestedNext } = await searchParams;
  const next = safeNextPath(requestedNext, '/dashboard');
  const user = await currentUser();
  // Password sign-in stays parked until the operator opts in: the form only
  // renders once invited-account creation is actually configured.
  const config = authFeatureConfig();
  const passwordLoginEnabled = config.passwordLogin;

  return (
    <main style={{ ...page, maxWidth: '28rem' }}>
      <h1 style={heading}>OpenSpell</h1>
      <p style={muted}>
        {passwordLoginEnabled
          ? 'Sign in with your work address. Invited accounts can use their password; magic link and Google remain available. There is no public signup—accounts are created only while accepting an invitation.'
          : 'Sign in with your work address. There is no public signup: accounts are created by invitation, so an address that is not already a member will not receive a link.'}
      </p>

      {error ? <p style={banner('bad')}>{error}</p> : null}
      {sent ? (
        <p style={banner('good')} data-testid="magic-link-sent">
          If that address belongs to a member, a sign-in link is on its way.
        </p>
      ) : null}
      {user ? (
        <p style={banner('good')}>
          You are already signed in. <a href={next}>Continue</a>.
        </p>
      ) : null}

      {supabaseConfigured() ? (
        <>
          {config.passkeyPolicy === 'sign-in' ? <PasskeySignIn next={next} /> : null}
          {passwordLoginEnabled ? (
            <>
              <form action={signInWithPassword} style={{ display: 'grid', gap: '0.5rem' }}>
                <input type="hidden" name="next" value={next} />
                <Field label="Email" htmlFor="password-email">
                  <Input
                    id="password-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                  />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </Field>
                <Button type="submit">
                  Sign in with password
                </Button>
                {config.passwordRecovery ? (
                  <a href="/forgot-password">Forgot password?</a>
                ) : null}
              </form>

              <div style={{ borderTop: '1px solid var(--wa-border)', margin: '1.25rem 0' }} />
            </>
          ) : null}

          <form action={sendMagicLink} style={{ display: 'grid', gap: '0.5rem' }}>
            <input type="hidden" name="next" value={next} />
            <Field label="Email" htmlFor="magic-email">
              <Input id="magic-email" name="email" type="email" autoComplete="email" required />
            </Field>
            <Button type="submit">Email me a sign-in link</Button>
          </form>

          <form action={signInWithGoogle} style={{ marginTop: '1rem' }}>
            <input type="hidden" name="next" value={next} />
            <Button type="submit">Continue with Google</Button>
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
