'use server';

import { authFeatureConfig } from '../../../src/auth/config';
import { gateAccountSecurityAction } from '../../../src/auth/guard';
import { authorizeSecurityChange } from '../../../src/auth/security-authorization';

export type PasskeyAuthorization =
  | { status: 'ok' }
  | { status: 'challenge'; href: string; message: string }
  | { status: 'error'; message: string };

/** Reauthorize on the server immediately before a browser passkey mutation. */
export async function authorizePasskeyMutation(): Promise<PasskeyAuthorization> {
  try {
    if (authFeatureConfig().passkeyPolicy === 'off') {
      return { status: 'error', message: 'Passkeys are not enabled.' };
    }
    await gateAccountSecurityAction();
    const authorization = await authorizeSecurityChange('/settings/account');
    if (authorization.status === 'ok') return { status: 'ok' };
    return authorization.status === 'challenge'
      ? {
          status: 'challenge',
          href: authorization.href,
          message: 'Verify your authenticator before changing passkeys.',
        }
      : { status: 'error', message: authorization.message };
  } catch {
    return { status: 'error', message: 'Account security could not be verified.' };
  }
}
