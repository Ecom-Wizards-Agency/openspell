'use server';

import { requestPasswordRecovery } from '../../src/auth/recovery';
import type { RecoveryRequestResult } from '../../src/auth/recovery';

export type RecoveryActionResult = { status: 'idle' } | RecoveryRequestResult;

export async function sendRecoveryLink(
  _previous: RecoveryActionResult,
  formData: FormData,
): Promise<RecoveryActionResult> {
  return requestPasswordRecovery(String(formData.get('email') ?? ''));
}
