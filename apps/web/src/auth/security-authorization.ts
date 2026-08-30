import { decideAssurance, requiredAssurance } from './assurance';
import type { SessionSecurity } from './assurance';
import { authFeatureConfig } from './config';
import type { AuthFeatureConfig } from './config';
import { assuranceDestination } from './continuation';
import { safeNextPath } from './next-path';
import { currentSessionSecurity, currentUser } from './session';
import type { SessionUser } from './session';
import type { OrgRole } from './roles';

export type SecurityAuthorization =
  | { status: 'ok'; user: SessionUser }
  | { status: 'challenge'; href: string }
  | { status: 'error'; message: string };

export interface OperatorIdentity {
  config: AuthFeatureConfig;
  /** Null is the intentional zero-provider-work path while enforcement is off. */
  security: SessionSecurity | null;
  user: SessionUser | null;
}

export function operatorAssuranceEnforced(config: AuthFeatureConfig): boolean {
  return (
    config.totpPolicy === 'enforce-when-enrolled' ||
    config.totpPolicy === 'require-for-privileged'
  );
}

/**
 * Resolve the primary identity once and fetch provider assurance only when the
 * rollout policy can actually refuse this request.
 */
export async function currentOperatorIdentity(
  config: AuthFeatureConfig = authFeatureConfig(),
): Promise<OperatorIdentity> {
  if (!operatorAssuranceEnforced(config)) {
    return { config, security: null, user: await currentUser() };
  }
  const security = await currentSessionSecurity();
  return {
    config,
    security,
    user: security.state === 'authenticated' ? security.user : null,
  };
}

/** One role-aware decision shared by pages, route handlers, Grid, and OAuth. */
export function authorizeOperatorRole(
  identity: OperatorIdentity,
  role: OrgRole,
  returnTo: string,
): SecurityAuthorization {
  const safeReturnTo = safeNextPath(returnTo, '/dashboard');
  if (identity.security === null) {
    return identity.user === null
      ? {
          status: 'challenge',
          href: `/login?${new URLSearchParams({ next: safeReturnTo }).toString()}`,
        }
      : { status: 'ok', user: identity.user };
  }

  const decision = decideAssurance({
    session: identity.security,
    requirement: requiredAssurance({
      config: identity.config,
      surface: 'operator',
      role,
    }),
    returnTo: safeReturnTo,
  });
  if (decision.kind === 'allow' && identity.security.state === 'authenticated') {
    return { status: 'ok', user: identity.security.user };
  }
  if (
    decision.kind === 'sign-in' ||
    decision.kind === 'challenge' ||
    decision.kind === 'enroll'
  ) {
    return { status: 'challenge', href: assuranceDestination(decision) };
  }
  return { status: 'error', message: 'Account security could not be verified. Try again.' };
}

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
