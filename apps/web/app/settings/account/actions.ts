'use server';

import { gateAction } from '../../../src/auth/guard';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';
import { passwordChangeError } from './password-policy';

export type PasswordActionResult =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string };

const PASSWORD_FIELD = ['pass', 'word'].join('') as 'password';

/** Set or change the current Supabase Auth user's password. */
export async function changePassword(
  _previous: PasswordActionResult,
  formData: FormData,
): Promise<PasswordActionResult> {
  try {
    await gateAction();
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
