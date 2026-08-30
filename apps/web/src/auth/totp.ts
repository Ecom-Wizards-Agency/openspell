import { authFeatureConfig } from './config';
import { authorizeSecurityChange } from './security-authorization';
import { supabaseConfigured, supabaseServerClient } from './supabase';

declare const totpFactorBrand: unique symbol;
export type TotpFactorId = string & { readonly [totpFactorBrand]: true };

export interface TotpFactorSummary {
  id: TotpFactorId;
  label: string | null;
  createdAt: string;
}

export type TotpOverview =
  | { status: 'ok'; factors: TotpFactorSummary[] }
  | { status: 'disabled'; message: string }
  | { status: 'error'; message: string };

export type TotpOperationResult =
  | { status: 'ok'; message: string }
  | { status: 'challenge'; message: string; href: string }
  | { status: 'error'; message: string };

export type TotpEnrollmentResult =
  | { status: 'idle' }
  | TotpOperationResult
  | {
      status: 'enrolling';
      factorId: TotpFactorId;
      qrCode: string;
      manualSecret: string;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOTP_CODE = /^\d{6}$/;

export async function loadTotpOverview(): Promise<TotpOverview> {
  if (!supabaseConfigured()) {
    return { status: 'disabled', message: 'Authenticator verification is not configured.' };
  }
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error || !data) {
    return { status: 'error', message: 'Authenticator factors could not be loaded.' };
  }
  const factors = data.totp.map((factor) => ({
    id: factor.id as TotpFactorId,
    label: factor.friendly_name ?? null,
    createdAt: factor.created_at,
  }));
  if (factors.length !== data.totp.length) {
    return { status: 'error', message: 'Authenticator factors could not be reconciled.' };
  }
  return { status: 'ok', factors };
}

export async function beginTotpEnrollment(): Promise<TotpEnrollmentResult> {
  if (!totpAvailable()) {
    return { status: 'error', message: 'Authenticator verification is not enabled.' };
  }
  const authorization = await authorizeSecurityChange('/settings/account');
  if (authorization.status !== 'ok') return authorizationResult(authorization);

  const supabase = await supabaseServerClient();
  const { data: listed, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !listed) {
    return { status: 'error', message: 'Authenticator setup could not start.' };
  }

  const stale = listed.all.filter(
    (factor) => factor.factor_type === 'totp' && factor.status === 'unverified',
  );
  let removed = 0;
  for (const factor of stale) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (error) return { status: 'error', message: 'Previous authenticator setup could not be cleared.' };
    removed += 1;
  }
  if (removed !== stale.length) {
    return { status: 'error', message: 'Previous authenticator setup could not be reconciled.' };
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'Authenticator app',
    issuer: 'OpenSpell',
  });
  if (error || !data || data.type !== 'totp') {
    return { status: 'error', message: 'Authenticator setup could not start.' };
  }
  return {
    status: 'enrolling',
    factorId: data.id as TotpFactorId,
    qrCode: data.totp.qr_code,
    manualSecret: data.totp.secret,
  };
}

export async function verifyTotpEnrollment(input: {
  factorId: string;
  code: string;
}): Promise<TotpOperationResult> {
  if (!totpAvailable()) {
    return { status: 'error', message: 'Authenticator verification is not enabled.' };
  }
  const authorization = await authorizeSecurityChange('/settings/account');
  if (authorization.status !== 'ok') return authorizationResult(authorization);
  return verifyOwnedTotp(input, false);
}

export async function verifyTotpChallenge(input: {
  factorId: string;
  code: string;
}): Promise<TotpOperationResult> {
  if (!supabaseConfigured()) {
    return { status: 'error', message: 'Authenticator verification is not configured.' };
  }
  return verifyOwnedTotp(input, true);
}

async function verifyOwnedTotp(
  input: { factorId: string; code: string },
  mustAlreadyBeVerified: boolean,
): Promise<TotpOperationResult> {
  if (!UUID.test(input.factorId) || !TOTP_CODE.test(input.code.trim())) {
    return { status: 'error', message: 'Enter the six-digit authenticator code.' };
  }
  const supabase = await supabaseServerClient();
  const { data: listed, error: listError } = await supabase.auth.mfa.listFactors();
  if (listError || !listed) return { status: 'error', message: 'Authenticator verification failed.' };
  const factor = listed.all.find(
    (candidate) => candidate.id === input.factorId && candidate.factor_type === 'totp',
  );
  if (!factor || (mustAlreadyBeVerified && factor.status !== 'verified')) {
    return { status: 'error', message: 'That authenticator is no longer available.' };
  }
  if (factor.status === 'verified' && !mustAlreadyBeVerified) {
    return { status: 'ok', message: 'Authenticator verification is enabled.' };
  }

  const { error } = await supabase.auth.mfa.challengeAndVerify({
    factorId: factor.id,
    code: input.code.trim(),
  });
  return error
    ? { status: 'error', message: 'The authenticator code was not accepted.' }
    : { status: 'ok', message: mustAlreadyBeVerified ? 'Authenticator verified.' : 'Authenticator verification is enabled.' };
}

export async function cancelTotpEnrollment(factorId: string): Promise<TotpOperationResult> {
  if (!UUID.test(factorId)) return { status: 'ok', message: 'Authenticator setup cancelled.' };
  const supabase = await supabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = data?.all.find(
    (candidate) =>
      candidate.id === factorId &&
      candidate.factor_type === 'totp' &&
      candidate.status === 'unverified',
  );
  if (!factor) return { status: 'ok', message: 'Authenticator setup cancelled.' };
  const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  return error
    ? { status: 'error', message: 'Authenticator setup could not be cancelled.' }
    : { status: 'ok', message: 'Authenticator setup cancelled.' };
}

export async function removeTotpFactor(factorId: string): Promise<TotpOperationResult> {
  if (!totpAvailable()) {
    return { status: 'error', message: 'Authenticator verification is not enabled.' };
  }
  const authorization = await authorizeSecurityChange('/settings/account');
  if (authorization.status !== 'ok') return authorizationResult(authorization);
  if (!UUID.test(factorId)) return { status: 'error', message: 'That authenticator is not valid.' };

  const supabase = await supabaseServerClient();
  const { data: listed, error: listError } = await supabase.auth.mfa.listFactors();
  const factor = listed?.totp.find((candidate) => candidate.id === factorId);
  if (listError || !factor) {
    return { status: 'error', message: 'That authenticator is no longer available.' };
  }
  const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
  if (error) return { status: 'error', message: 'The authenticator could not be removed.' };
  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
  if (refreshError || !refreshed.session) {
    // Clear the cookie-backed local session so a stale AAL2 token cannot keep
    // authorizing requests after its factor has disappeared.
    await supabase.auth.signOut({ scope: 'local' });
    return {
      status: 'error',
      message: 'Authenticator removed. Sign in again before continuing.',
    };
  }
  return { status: 'ok', message: 'Authenticator removed.' };
}

function totpAvailable(): boolean {
  return authFeatureConfig().totpPolicy !== 'off' && supabaseConfigured();
}

function authorizationResult(
  authorization: Exclude<Awaited<ReturnType<typeof authorizeSecurityChange>>, { status: 'ok' }>,
): TotpOperationResult {
  return authorization.status === 'challenge'
    ? {
        status: 'challenge',
        message: 'Verify an existing authenticator before changing account security.',
        href: authorization.href,
      }
    : { status: 'error', message: authorization.message };
}
