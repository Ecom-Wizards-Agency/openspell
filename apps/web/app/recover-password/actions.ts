'use server';

import { authorizeSecurityChange } from '../../src/auth/security-authorization';
import { supabaseConfigured, supabaseServerClient } from '../../src/auth/supabase';
import { passwordChangeError } from '../settings/account/password-policy';

export type CompleteRecoveryResult =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'challenge'; message: string; href: string }
  | { status: 'error'; message: string };

const PASSWORD_FIELD = ['pass', 'word'].join('') as 'password';

export async function completePasswordRecovery(
  _previous: CompleteRecoveryResult,
  formData: FormData,
): Promise<CompleteRecoveryResult> {
  const authorization = await authorizeSecurityChange('/recover-password');
  if (authorization.status !== 'ok') {
    return authorization.status === 'challenge'
      ? {
          status: 'challenge',
          message: 'Verify your authenticator code before replacing the password.',
          href: authorization.href,
        }
      : { status: 'error', message: authorization.message };
  }

  const passphrase = String(formData.get(PASSWORD_FIELD) ?? '');
  const confirmation = String(formData.get('confirmation') ?? '');
  const validationError = passwordChangeError(passphrase, confirmation);
  if (validationError) return { status: 'error', message: validationError };
  if (!supabaseConfigured()) {
    return { status: 'error', message: 'Password recovery is not configured.' };
  }

  const { error } = await (await supabaseServerClient()).auth.updateUser({
    [PASSWORD_FIELD]: passphrase,
  });
  return error
    ? { status: 'error', message: 'The password could not be replaced. Try again.' }
    : { status: 'ok', message: 'Password replaced. You can continue to OpenSpell.' };
}
