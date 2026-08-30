import { describe, expect, it } from 'vitest';
import { assuranceDestination, authContinuePath } from './continuation';

describe('auth continuation paths', () => {
  it('keeps a local destination and rejects an external one', () => {
    expect(authContinuePath('/invite/abc?step=accept')).toBe(
      '/auth/continue?next=%2Finvite%2Fabc%3Fstep%3Daccept',
    );
    expect(authContinuePath('//example.test')).toBe('/auth/continue?next=%2Fdashboard');
  });

  it('encodes challenge and enrollment return paths', () => {
    expect(
      assuranceDestination({ kind: 'challenge', returnTo: '/settings/account?tab=security' }),
    ).toBe('/auth/mfa/challenge?next=%2Fsettings%2Faccount%3Ftab%3Dsecurity');
    expect(assuranceDestination({ kind: 'enroll', returnTo: '/dashboard' })).toBe(
      '/settings/account?mfa=enroll&next=%2Fdashboard',
    );
  });
});
