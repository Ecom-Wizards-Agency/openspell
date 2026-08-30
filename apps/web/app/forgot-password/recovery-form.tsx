'use client';

import { useActionState } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button, Field, Input } from '../../src/ui/primitives';
import { sendRecoveryLink } from './actions';
import type { RecoveryActionResult } from './actions';

const IDLE: RecoveryActionResult = { status: 'idle' };

export function RecoveryForm(): ReactNode {
  const [result, action, pending] = useActionState(sendRecoveryLink, IDLE);

  return (
    <>
      <form action={action} style={{ display: 'grid', gap: '0.75rem' }}>
        <Field label="Work email" htmlFor="recovery-email">
          <Input
            id="recovery-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={pending}
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending...' : 'Send recovery link'}
        </Button>
      </form>
      {result.status === 'idle' ? null : result.status === 'sent' ? (
        <Banner tone="good" role="status" data-testid="recovery-sent">
          If that address belongs to a member, a recovery link is on its way.
        </Banner>
      ) : (
        <Banner tone="bad" role="alert">
          {result.message}
        </Banner>
      )}
    </>
  );
}
