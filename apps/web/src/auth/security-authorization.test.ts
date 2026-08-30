import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFeatureConfig, TotpPolicy } from './config';

const user = { id: 'user-1', email: null };
const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  currentSessionSecurity: vi.fn(),
}));

vi.mock('./session', () => ({
  currentUser: mocks.currentUser,
  currentSessionSecurity: mocks.currentSessionSecurity,
}));

import {
  authorizeOperatorRole,
  currentOperatorIdentity,
} from './security-authorization';

function config(totpPolicy: TotpPolicy): AuthFeatureConfig {
  return {
    passwordLogin: false,
    passwordRecovery: false,
    googleLogin: false,
    passkeyPolicy: 'off',
    totpPolicy,
  };
}

describe('operator security authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUser.mockResolvedValue(user);
  });

  it('does no assurance-provider work while enforcement is off', async () => {
    const identity = await currentOperatorIdentity(config('off'));
    expect(identity).toEqual({ config: config('off'), security: null, user });
    expect(mocks.currentUser).toHaveBeenCalledTimes(1);
    expect(mocks.currentSessionSecurity).not.toHaveBeenCalled();
    expect(authorizeOperatorRole(identity, 'owner', '/dashboard')).toEqual({
      status: 'ok',
      user,
    });
  });

  it('challenges an enrolled AAL1 session before a protected surface', () => {
    expect(
      authorizeOperatorRole(
        {
          config: config('enforce-when-enrolled'),
          security: { state: 'authenticated', user, current: 'aal1', next: 'aal2' },
          user,
        },
        'viewer',
        '/grid',
      ),
    ).toEqual({ status: 'challenge', href: '/auth/mfa/challenge?next=%2Fgrid' });
  });

  it('requires privileged enrollment but lets an unprivileged no-factor session continue', () => {
    const identity = {
      config: config('require-for-privileged'),
      security: { state: 'authenticated' as const, user, current: 'aal1' as const, next: 'aal1' as const },
      user,
    };
    expect(authorizeOperatorRole(identity, 'admin', '/dashboard')).toEqual({
      status: 'challenge',
      href: '/settings/account?mfa=enroll&next=%2Fdashboard',
    });
    expect(authorizeOperatorRole(identity, 'viewer', '/dashboard')).toEqual({
      status: 'ok',
      user,
    });
  });

  it('fails closed when provider assurance is unavailable', () => {
    expect(
      authorizeOperatorRole(
        {
          config: config('enforce-when-enrolled'),
          security: { state: 'unavailable', reason: 'provider-error' },
          user: null,
        },
        'owner',
        '/dashboard',
      ),
    ).toEqual({
      status: 'error',
      message: 'Account security could not be verified. Try again.',
    });
  });
});
