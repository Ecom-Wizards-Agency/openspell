'use server';

import { revalidatePath } from 'next/cache';
import {
  beginTotpEnrollment,
  cancelTotpEnrollment,
  removeTotpFactor,
  verifyTotpEnrollment,
} from '../../../src/auth/totp';
import type { TotpEnrollmentResult, TotpOperationResult } from '../../../src/auth/totp';

export async function startTotpEnrollment(
  _previous: TotpEnrollmentResult,
): Promise<TotpEnrollmentResult> {
  return beginTotpEnrollment();
}

export async function confirmTotpEnrollment(
  _previous: TotpOperationResult | { status: 'idle' },
  formData: FormData,
): Promise<TotpOperationResult | { status: 'idle' }> {
  const result = await verifyTotpEnrollment({
    factorId: String(formData.get('factorId') ?? ''),
    code: String(formData.get('code') ?? ''),
  });
  if (result.status === 'ok') revalidatePath('/settings/account');
  return result;
}

export async function cancelTotpSetup(formData: FormData): Promise<void> {
  await cancelTotpEnrollment(String(formData.get('factorId') ?? ''));
  revalidatePath('/settings/account');
}

export async function removeTotp(
  _previous: TotpOperationResult | { status: 'idle' },
  formData: FormData,
): Promise<TotpOperationResult | { status: 'idle' }> {
  const result = await removeTotpFactor(String(formData.get('factorId') ?? ''));
  if (result.status === 'ok') revalidatePath('/settings/account');
  return result;
}
