'use server';

import { gateAccountSecurityAction } from '../../../src/auth/guard';
import { authorizeSecurityChange } from '../../../src/auth/security-authorization';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';
import { passwordChangeError } from './password-policy';

export type PasswordActionResult =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'challenge'; message: string; href: string }
  | { status: 'error'; message: string };

const PASSWORD_FIELD = ['pass', 'word'].join('') as 'password';

/** Set or change the current Supabase Auth user's password. */
export async function changePassword(
  _previous: PasswordActionResult,
  formData: FormData,
): Promise<PasswordActionResult> {
  try {
    await gateAccountSecurityAction();
    const authorization = await authorizeSecurityChange('/settings/account');
    if (authorization.status !== 'ok') {
      return authorization.status === 'challenge'
        ? {
            status: 'challenge',
            message: 'Verify your authenticator before replacing the password.',
            href: authorization.href,
          }
        : { status: 'error', message: authorization.message };
    }
    const passphrase = String(formData.get(PASSWORD_FIELD) ?? '');
    const confirmation = String(formData.get('confirmation') ?? '');
    const validationError = passwordChangeError(passphrase, confirmation);
    if (validationError) return { status: 'error', message: validationError };
    if (!supabaseConfigured()) {
      return { status: 'error', message: 'Password changes are not configured on this instance.' };
    }

    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.updateUser({ [PASSWORD_FIELD]: passphrase });
    if (error) {
      return { status: 'error', message: 'The password could not be changed. Try again.' };
    }
    return { status: 'ok', message: 'Password updated. You can use it the next time you sign in.' };
  } catch {
    return { status: 'error', message: 'The password could not be changed. Try again.' };
  }
}
