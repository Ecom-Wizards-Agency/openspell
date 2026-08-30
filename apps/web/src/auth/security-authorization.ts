import { decideAssurance, requiredAssurance } from './assurance';
import { authFeatureConfig } from './config';
import { assuranceDestination } from './continuation';
import { safeNextPath } from './next-path';
import { currentSessionSecurity } from './session';
import type { SessionUser } from './session';

export type SecurityAuthorization =
  | { status: 'ok'; user: SessionUser }
  | { status: 'challenge'; href: string }
  | { status: 'error'; message: string };

/** Require the strongest assurance already available before credential changes. */
export async function authorizeSecurityChange(returnTo: string): Promise<SecurityAuthorization> {
  const safeReturnTo = safeNextPath(returnTo, '/settings/account');
  const session = await currentSessionSecurity();
  const decision = decideAssurance({
    session,
    requirement: requiredAssurance({
      config: authFeatureConfig(),
      surface: 'account-security',
    }),
    returnTo: safeReturnTo,
  });
  if (decision.kind === 'allow' && session.state === 'authenticated') {
    return { status: 'ok', user: session.user };
  }
  if (decision.kind === 'challenge') {
    return { status: 'challenge', href: assuranceDestination(decision) };
  }
  return {
    status: 'error',
    message:
      decision.kind === 'sign-in'
        ? 'Sign in again before changing account security.'
        : 'Account security could not be verified. Try again.',
  };
}
