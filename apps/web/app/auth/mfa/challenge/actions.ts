'use server';

import { redirect } from 'next/navigation';
import { authContinuePath } from '../../../../src/auth/continuation';
import { safeNextPath } from '../../../../src/auth/next-path';
import { verifyTotpChallenge } from '../../../../src/auth/totp';
import type { TotpOperationResult } from '../../../../src/auth/totp';

export type ChallengeActionResult = TotpOperationResult | { status: 'idle' };

export async function submitTotpChallenge(
  _previous: ChallengeActionResult,
  formData: FormData,
): Promise<ChallengeActionResult> {
  const next = safeNextPath(String(formData.get('next') ?? ''), '/dashboard');
  const result = await verifyTotpChallenge({
    factorId: String(formData.get('factorId') ?? ''),
    code: String(formData.get('code') ?? ''),
  });
  if (result.status === 'ok') redirect(authContinuePath(next));
  return result;
}
