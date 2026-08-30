import type { OrgRole } from './roles';
import type { AuthFeatureConfig } from './config';
import type { SessionUser } from './session';

export type AssuranceLevel = 'aal1' | 'aal2';

export type SessionSecurity =
  | { state: 'anonymous' }
  | {
      state: 'authenticated';
      user: SessionUser;
      current: AssuranceLevel;
      next: AssuranceLevel;
    }
  | { state: 'unavailable'; reason: 'provider-error' | 'unknown-assurance' };

export type AssuranceRequirement = 'primary' | 'maximum-available' | 'aal2';

export type AssuranceDecision =
  | { kind: 'allow' }
  | { kind: 'sign-in'; returnTo: string }
  | { kind: 'challenge'; returnTo: string }
  | { kind: 'enroll'; returnTo: string }
  | { kind: 'unavailable' };

export type AuthSurface = 'operator' | 'account-security' | 'recovery';

/** The policy owns which role and operation requires which assurance. */
export function requiredAssurance(input: {
  config: AuthFeatureConfig;
  surface: AuthSurface;
  role?: OrgRole;
}): AssuranceRequirement {
  if (input.surface === 'account-security' || input.surface === 'recovery') {
    return 'maximum-available';
  }

  switch (input.config.totpPolicy) {
    case 'off':
    case 'enrollment-only':
      return 'primary';
    case 'enforce-when-enrolled':
      return 'maximum-available';
    case 'require-for-privileged':
      return input.role === 'owner' || input.role === 'admin' ? 'aal2' : 'maximum-available';
  }
}

export function decideAssurance(input: {
  session: SessionSecurity;
  requirement: AssuranceRequirement;
  returnTo: string;
}): AssuranceDecision {
  if (input.session.state === 'anonymous') {
    return { kind: 'sign-in', returnTo: input.returnTo };
  }
  if (input.session.state === 'unavailable') return { kind: 'unavailable' };
  if (input.requirement === 'primary' || input.session.current === 'aal2') {
    return { kind: 'allow' };
  }
  if (input.session.next === 'aal2') {
    return { kind: 'challenge', returnTo: input.returnTo };
  }
  return input.requirement === 'aal2'
    ? { kind: 'enroll', returnTo: input.returnTo }
    : { kind: 'allow' };
}

export function isAssuranceLevel(value: unknown): value is AssuranceLevel {
  return value === 'aal1' || value === 'aal2';
}
