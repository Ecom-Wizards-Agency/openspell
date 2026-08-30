'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Banner, Button, Card, Field, Input, LinkButton } from '../../../src/ui/primitives';
import { changePassword } from './actions';
import type { PasswordActionResult } from './actions';

const IDLE: PasswordActionResult = { status: 'idle' };

export function PasswordForm(): ReactNode {
  const [result, action, pending] = useActionState(changePassword, IDLE);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (result.status === 'ok') formRef.current?.reset();
  }, [result]);

  return (
    <Card
      title="Password"
      subtitle="Use this alongside magic-link or Google sign-in."
    >
      <form
        ref={formRef}
        action={action}
        style={{ display: 'grid', gap: '0.75rem', maxWidth: '28rem' }}
      >
        <Field label="New password" htmlFor="account-password" hint="Use at least 10 characters.">
          <Input
            id="account-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            disabled={pending}
          />
        </Field>
        <Field label="Confirm password" htmlFor="account-password-confirmation">
          <Input
            id="account-password-confirmation"
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
            disabled={pending}
          />
        </Field>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Set password'}
          </Button>
        </div>
      </form>
      {result.status === 'idle' ? null : (
        <Banner
          tone={result.status === 'ok' ? 'good' : result.status === 'challenge' ? 'warn' : 'bad'}
          role={result.status === 'ok' ? 'status' : 'alert'}
          data-testid="password-result"
        >
          {result.message}
        </Banner>
      )}
      {result.status === 'challenge' ? (
        <LinkButton href={result.href}>Verify authenticator</LinkButton>
      ) : null}
    </Card>
  );
}
