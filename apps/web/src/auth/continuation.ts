import { safeNextPath } from './next-path';
import type { AssuranceDecision } from './assurance';

export function authContinuePath(next: string | null | undefined): string {
  const query = new URLSearchParams({ next: safeNextPath(next, '/dashboard') });
  return `/auth/continue?${query.toString()}`;
}

export function assuranceDestination(decision: AssuranceDecision): string {
  switch (decision.kind) {
    case 'allow':
      throw new Error('allow decisions need the caller\'s validated destination');
    case 'sign-in':
      return `/login?${new URLSearchParams({ next: decision.returnTo }).toString()}`;
    case 'challenge':
      return `/auth/mfa/challenge?${new URLSearchParams({ next: decision.returnTo }).toString()}`;
    case 'enroll':
      return `/settings/account?${new URLSearchParams({ mfa: 'enroll', next: decision.returnTo }).toString()}`;
    case 'unavailable':
      return '/login?error=account+security+could+not+be+verified';
  }
}
