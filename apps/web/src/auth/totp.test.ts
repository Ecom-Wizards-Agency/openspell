import { beforeEach, describe, expect, it, vi } from 'vitest';

const FACTOR_ID = '11111111-1111-4111-8111-111111111111';
const STALE_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  listFactors: vi.fn(),
  unenroll: vi.fn(),
  enroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('./config', () => ({
  authFeatureConfig: () => ({ totpPolicy: 'enrollment-only' }),
}));
vi.mock('./security-authorization', () => ({
  authorizeSecurityChange: mocks.authorize,
}));
vi.mock('./supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: {
      mfa: {
        listFactors: mocks.listFactors,
        unenroll: mocks.unenroll,
        enroll: mocks.enroll,
        challengeAndVerify: mocks.challengeAndVerify,
      },
      refreshSession: mocks.refreshSession,
      signOut: mocks.signOut,
    },
  }),
}));

import { beginTotpEnrollment, removeTotpFactor, verifyTotpChallenge } from './totp';

describe('TOTP operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      status: 'ok',
      user: { id: 'user-1', email: 'member@example.test' },
    });
    mocks.unenroll.mockResolvedValue({ data: {}, error: null });
    mocks.challengeAndVerify.mockResolvedValue({ data: {}, error: null });
    mocks.refreshSession.mockResolvedValue({ data: { session: {} }, error: null });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it('cleans up every stale enrollment before creating exactly one replacement', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [
          { id: STALE_ID, factor_type: 'totp', status: 'unverified' },
          { id: FACTOR_ID, factor_type: 'totp', status: 'verified' },
        ],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.enroll.mockResolvedValue({
      data: {
        id: STALE_ID,
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;utf-8,%3Csvg%20/%3E', secret: 'MANUAL' },
      },
      error: null,
    });

    await expect(beginTotpEnrollment()).resolves.toEqual({
      status: 'enrolling',
      factorId: STALE_ID,
      qrCode: 'data:image/svg+xml;utf-8,%3Csvg%20/%3E',
      manualSecret: 'MANUAL',
    });
    expect(mocks.unenroll).toHaveBeenCalledTimes(1);
    expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: STALE_ID });
    expect(mocks.enroll).toHaveBeenCalledTimes(1);
  });

  it('verifies only a listed, already-verified TOTP challenge factor', async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [], totp: [] },
      error: null,
    });
    await expect(verifyTotpChallenge({ factorId: FACTOR_ID, code: '123456' })).resolves.toEqual({
      status: 'error',
      message: 'That authenticator is no longer available.',
    });
    expect(mocks.challengeAndVerify).not.toHaveBeenCalled();
  });

  it('requires server-side step-up before removing an authenticator', async () => {
    mocks.authorize.mockResolvedValue({ status: 'challenge', href: '/auth/mfa/challenge' });
    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'challenge',
      message: 'Verify an existing authenticator before changing account security.',
      href: '/auth/mfa/challenge',
    });
    expect(mocks.listFactors).not.toHaveBeenCalled();
    expect(mocks.unenroll).not.toHaveBeenCalled();
  });

  it('reports a removed factor but refuses to continue on a stale session', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: null,
    });

    await expect(removeTotpFactor(FACTOR_ID)).resolves.toEqual({
      status: 'error',
      message: 'Authenticator removed. Sign in again before continuing.',
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('also clears the local session when the refresh provider returns an error', async () => {
    mocks.listFactors.mockResolvedValue({
      data: {
        all: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
        totp: [{ id: FACTOR_ID, factor_type: 'totp', status: 'verified' }],
      },
      error: null,
    });
    mocks.refreshSession.mockResolvedValue({
      data: { session: null, user: null },
      error: new Error('refresh failed'),
    });

    await expect(removeTotpFactor(FACTOR_ID)).resolves.toMatchObject({ status: 'error' });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
