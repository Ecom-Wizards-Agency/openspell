'use client';

import { useActionState, useEffect } from 'react';
import type { ReactNode } from 'react';
import Image from 'next/image';
import type { TotpEnrollmentResult, TotpOverview, TotpOperationResult } from '../../../src/auth/totp';
import { authContinuePath } from '../../../src/auth/continuation';
import { Banner, Button, Card, Field, Input, LinkButton } from '../../../src/ui/primitives';
import {
  cancelTotpSetup,
  confirmTotpEnrollment,
  removeTotp,
  startTotpEnrollment,
} from './totp-actions';

const IDLE_ENROLLMENT: TotpEnrollmentResult = { status: 'idle' };
const IDLE_OPERATION: TotpOperationResult | { status: 'idle' } = { status: 'idle' };

export function TotpManager({ overview, next }: { overview: TotpOverview; next: string }): ReactNode {
  const [enrollment, start, starting] = useActionState(startTotpEnrollment, IDLE_ENROLLMENT);
  const [verification, verify, verifying] = useActionState(confirmTotpEnrollment, IDLE_OPERATION);

  useEffect(() => {
    if (verification.status === 'ok') window.location.assign(authContinuePath(next));
  }, [next, verification]);

  return (
    <Card title="Authenticator verification" subtitle="Use a six-digit code as a second sign-in step.">
      {overview.status === 'error' ? <Banner tone="bad">{overview.message}</Banner> : null}
      {overview.status === 'disabled' ? <Banner tone="warn">{overview.message}</Banner> : null}
      {overview.status === 'ok' && overview.factors.length > 0 ? (
        <ul>
          {overview.factors.map((factor) => (
            <li key={factor.id} style={{ marginBottom: '0.75rem' }}>
              {factor.label ?? 'Authenticator app'}
              <RemoveTotp factorId={factor.id} />
            </li>
          ))}
        </ul>
      ) : null}

      {overview.status === 'ok' && enrollment.status !== 'enrolling' ? (
        <form action={start}>
          <Button type="submit" disabled={starting}>{starting ? 'Starting...' : 'Add authenticator'}</Button>
        </form>
      ) : null}

      {enrollment.status === 'enrolling' ? (
        <div style={{ display: 'grid', gap: '0.75rem', maxWidth: '28rem' }}>
          <Image
            src={enrollment.qrCode}
            alt="Authenticator setup QR code"
            width={220}
            height={220}
            unoptimized
          />
          <p>Manual setup code: <code>{enrollment.manualSecret}</code></p>
          <form action={verify} style={{ display: 'grid', gap: '0.75rem' }}>
            <input type="hidden" name="factorId" value={enrollment.factorId} />
            <Field label="Six-digit code" htmlFor="totp-enrollment-code">
              <Input id="totp-enrollment-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required disabled={verifying} />
            </Field>
            <Button type="submit" disabled={verifying}>{verifying ? 'Verifying...' : 'Enable authenticator'}</Button>
          </form>
          <form action={cancelTotpSetup}>
            <input type="hidden" name="factorId" value={enrollment.factorId} />
            <Button type="submit" variant="ghost">Cancel setup</Button>
          </form>
        </div>
      ) : null}

      {enrollment.status === 'error' ? <Banner tone="bad">{enrollment.message}</Banner> : null}
      {enrollment.status === 'challenge' ? <Banner tone="warn">{enrollment.message}</Banner> : null}
      {enrollment.status === 'challenge' ? <LinkButton href={enrollment.href}>Verify authenticator</LinkButton> : null}
      {verification.status === 'error' ? <Banner tone="bad">{verification.message}</Banner> : null}
      {verification.status === 'challenge' ? <LinkButton href={verification.href}>Verify authenticator</LinkButton> : null}
    </Card>
  );
}

function RemoveTotp({ factorId }: { factorId: string }): ReactNode {
  const [result, action, pending] = useActionState(removeTotp, IDLE_OPERATION);
  return (
    <span style={{ marginLeft: '0.75rem' }}>
      <form action={action} style={{ display: 'inline' }}>
        <input type="hidden" name="factorId" value={factorId} />
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? 'Removing...' : 'Remove'}
        </Button>
      </form>
      {result.status === 'error' ? <Banner tone="bad">{result.message}</Banner> : null}
      {result.status === 'challenge' ? (
        <LinkButton href={result.href}>Verify authenticator</LinkButton>
      ) : null}
    </span>
  );
}
