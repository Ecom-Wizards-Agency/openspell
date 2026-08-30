import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw { location };
  },
}));
vi.mock('../../src/auth/config', () => ({ authFeatureConfig: mocks.config }));
vi.mock('../../src/auth/origin', () => ({ authOrigin: () => 'https://app.example.test' }));
vi.mock('../../src/auth/supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signInWithOtp: mocks.signInWithOtp,
      signInWithOAuth: mocks.signInWithOAuth,
    },
  }),
}));

import { sendMagicLink, signInWithGoogle, signInWithPassword } from './actions';

async function redirectLocation(operation: Promise<void>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'location' in error &&
      typeof error.location === 'string'
    ) {
      return error.location;
    }
    throw error;
  }
  throw new Error('expected redirect');
}

function credentials(): FormData {
  const form = new FormData();
  form.set('email', 'member@example.test');
  form.set('password', 'synthetic passphrase');
  form.set('next', '/dashboard');
  return form;
}

describe('login actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue({
      passwordLogin: false,
      passwordRecovery: false,
      googleLogin: false,
      totpPolicy: 'off',
      passkeyPolicy: 'off',
    });
  });

  it('refuses password and Google provider calls while their rollout flags are off', async () => {
    await expect(redirectLocation(signInWithPassword(credentials()))).resolves.toContain(
      'password+sign-in+is+not+enabled',
    );
    await expect(redirectLocation(signInWithGoogle(credentials()))).resolves.toContain(
      'Google+sign-in+is+not+enabled',
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('returns the same magic-link receipt for accepted and refused addresses', async () => {
    for (const result of [
      { data: {}, error: null },
      { data: {}, error: new Error('provider refusal') },
    ]) {
      mocks.signInWithOtp.mockResolvedValueOnce(result);
      const location = await redirectLocation(sendMagicLink(credentials()));
      expect(location).toBe('/login?next=%2Fdashboard&sent=1');
    }
    expect(mocks.signInWithOtp).toHaveBeenCalledTimes(2);
    expect(mocks.signInWithOtp).toHaveBeenLastCalledWith({
      email: 'member@example.test',
      options: {
        shouldCreateUser: false,
        emailRedirectTo:
          'https://app.example.test/auth/callback?next=%2Fdashboard',
      },
    });
  });
});
