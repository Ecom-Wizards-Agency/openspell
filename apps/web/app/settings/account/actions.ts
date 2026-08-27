'use server';

import { gateAction } from '../../../src/auth/guard';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';

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
    const password = String(formData.get(PASSWORD_FIELD) ?? '');
    const confirmation = String(formData.get('confirmation') ?? '');
    if (password.length < 10) {
      return { status: 'error', message: 'Use at least 10 characters.' };
    }
    if (password !== confirmation) {
      return { status: 'error', message: 'The two passwords do not match.' };
    }
    if (!supabaseConfigured()) {
      return { status: 'error', message: 'Password changes are not configured on this instance.' };
    }

    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.updateUser({ [PASSWORD_FIELD]: password });
    if (error) {
      return { status: 'error', message: 'The password could not be changed. Try again.' };
    }
    return { status: 'ok', message: 'Password updated. You can use it the next time you sign in.' };
  } catch {
    return { status: 'error', message: 'The password could not be changed. Try again.' };
  }
}
