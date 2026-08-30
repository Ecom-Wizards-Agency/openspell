import { describe, expect, it } from 'vitest';
import { decideAssurance, requiredAssurance } from './assurance';
import type { AuthFeatureConfig, TotpPolicy } from './config';
import type { OrgRole } from './roles';

const user = { id: 'user-1', email: null };

const config = (totpPolicy: TotpPolicy): AuthFeatureConfig => ({
  passwordLogin: false,
  passwordRecovery: false,
  googleLogin: false,
  passkeyPolicy: 'off',
  totpPolicy,
});

describe('assurance policy', () => {
  it.each([
    ['off', 'primary'],
    ['enrollment-only', 'primary'],
    ['enforce-when-enrolled', 'maximum-available'],
  ] as const)('maps %s operator policy to %s', (policy, expected) => {
    expect(requiredAssurance({ config: config(policy), surface: 'operator' })).toBe(expected);
  });

  it.each([
    ['owner', 'aal2'],
    ['admin', 'aal2'],
    ['analyst', 'maximum-available'],
    ['viewer', 'maximum-available'],
  ] as const)('maps privileged policy for %s to %s', (role, expected) => {
    expect(
      requiredAssurance({
        config: config('require-for-privileged'),
        surface: 'operator',
        role: role as OrgRole,
      }),
    ).toBe(expected);
  });

  it('requires the strongest available level for account and recovery changes', () => {
    expect(requiredAssurance({ config: config('off'), surface: 'account-security' })).toBe(
      'maximum-available',
    );
    expect(requiredAssurance({ config: config('off'), surface: 'recovery' })).toBe(
      'maximum-available',
    );
  });

  it.each([
    [{ state: 'anonymous' } as const, 'maximum-available', 'sign-in'],
    [
      { state: 'unavailable', reason: 'provider-error' } as const,
      'maximum-available',
      'unavailable',
    ],
    [
      { state: 'authenticated', user, current: 'aal1', next: 'aal1' } as const,
      'maximum-available',
      'allow',
    ],
    [
      { state: 'authenticated', user, current: 'aal1', next: 'aal2' } as const,
      'maximum-available',
      'challenge',
    ],
    [
      { state: 'authenticated', user, current: 'aal1', next: 'aal1' } as const,
      'aal2',
      'enroll',
    ],
    [
      { state: 'authenticated', user, current: 'aal2', next: 'aal2' } as const,
      'aal2',
      'allow',
    ],
  ] as const)('decides %s plus %s as %s', (session, requirement, expected) => {
    expect(decideAssurance({ session, requirement, returnTo: '/dashboard' }).kind).toBe(expected);
  });
});
