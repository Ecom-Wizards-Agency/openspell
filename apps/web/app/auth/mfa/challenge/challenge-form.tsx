'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import type { TotpFactorSummary } from '../../../../src/auth/totp';
import { Banner, Button, Field, Input, Select } from '../../../../src/ui/primitives';
import { submitTotpChallenge } from './actions';
import type { ChallengeActionResult } from './actions';

const IDLE: ChallengeActionResult = { status: 'idle' };

export function TotpChallengeForm({ factors, next }: { factors: TotpFactorSummary[]; next: string }): ReactNode {
  const [result, action, pending] = useActionState(submitTotpChallenge, IDLE);
  return (
    <>
      <form action={action} style={{ display: 'grid', gap: '0.75rem' }}>
        <input type="hidden" name="next" value={next} />
        <Field label="Authenticator" htmlFor="totp-factor">
          <Select id="totp-factor" name="factorId" required disabled={pending}>
            {factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.label ?? 'Authenticator app'}</option>)}
          </Select>
        </Field>
        <Field label="Six-digit code" htmlFor="totp-code">
          <Input id="totp-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required disabled={pending} />
        </Field>
        <Button type="submit" disabled={pending}>{pending ? 'Verifying...' : 'Verify and continue'}</Button>
      </form>
      {result.status === 'error' ? <Banner tone="bad" role="alert">{result.message}</Banner> : null}
    </>
  );
}
