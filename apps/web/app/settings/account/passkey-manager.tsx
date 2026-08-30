'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { PasskeyPolicy } from '../../../src/auth/config';
import { browserPasskeys } from '../../../src/auth/passkeys.client';
import type { PasskeyResult, PasskeySummary } from '../../../src/auth/passkeys.client';
import { Banner, Button, Card, Input, LinkButton } from '../../../src/ui/primitives';
import { authorizePasskeyMutation } from './passkey-actions';

export function PasskeyManager({ policy }: { policy: Exclude<PasskeyPolicy, 'off'> }): ReactNode {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [message, setMessage] = useState<PasskeyResult | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const adapter = browserPasskeys();
    if (adapter === null) {
      setMessage({ status: 'error', message: 'Passkeys are not configured.' });
      return;
    }
    const result = await adapter.list();
    if (result.status === 'ok') setPasskeys(result.passkeys);
    else setMessage(result);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(operation: () => Promise<PasskeyResult>): Promise<void> {
    setPending(true);
    const authorization = await authorizePasskeyMutation();
    if (authorization.status === 'challenge') {
      window.location.assign(authorization.href);
      return;
    }
    if (authorization.status === 'error') {
      setMessage(authorization);
      setPending(false);
      return;
    }
    const result = await operation();
    setMessage(result);
    if (result.status === 'ok') await load();
    setPending(false);
  }

  const canEnroll = policy === 'enroll' || policy === 'sign-in';

  return (
    <Card
      title="Passkeys (experimental)"
      subtitle="Provider APIs may change. Email sign-in links remain available as a fallback."
    >
      {passkeys.length === 0 ? <p>No passkeys registered.</p> : (
        <ul>
          {passkeys.map((passkey) => (
            <li key={passkey.id} style={{ marginBottom: '0.75rem' }}>
              <PasskeyRow
                passkey={passkey}
                pending={pending}
                onRename={(name) => mutate(async () => {
                  const adapter = browserPasskeys();
                  return adapter === null
                    ? { status: 'error', message: 'Passkeys are not configured.' }
                    : adapter.rename(passkey.id, name);
                })}
                onRemove={() => mutate(async () => {
                  const adapter = browserPasskeys();
                  return adapter === null
                    ? { status: 'error', message: 'Passkeys are not configured.' }
                    : adapter.remove(passkey.id);
                })}
              />
            </li>
          ))}
        </ul>
      )}
      {canEnroll ? (
        <Button
          type="button"
          disabled={pending}
          onClick={() => mutate(async () => {
            const adapter = browserPasskeys();
            return adapter === null
              ? { status: 'error', message: 'Passkeys are not configured.' }
              : adapter.register();
          })}
        >
          Add passkey
        </Button>
      ) : null}
      {message === null ? null : (
        <Banner tone={message.status === 'ok' ? 'good' : 'bad'}>{message.message}</Banner>
      )}
      <p><LinkButton href="/login">Use an email sign-in link</LinkButton></p>
    </Card>
  );
}

function PasskeyRow({
  passkey,
  pending,
  onRename,
  onRemove,
}: {
  passkey: PasskeySummary;
  pending: boolean;
  onRename(name: string): Promise<void>;
  onRemove(): Promise<void>;
}): ReactNode {
  async function rename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await onRename(String(form.get('friendlyName') ?? ''));
  }
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <form onSubmit={rename} style={{ display: 'flex', gap: '0.5rem' }}>
        <Input
          aria-label="Passkey name"
          name="friendlyName"
          defaultValue={passkey.name ?? 'Passkey'}
          maxLength={120}
          required
          disabled={pending}
        />
        <Button type="submit" size="sm" disabled={pending}>Rename</Button>
      </form>
      <Button type="button" size="sm" variant="danger" disabled={pending} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}
