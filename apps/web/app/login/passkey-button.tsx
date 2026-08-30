'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { authContinuePath } from '../../src/auth/continuation';
import { browserPasskeys } from '../../src/auth/passkeys.client';
import { Banner, Button } from '../../src/ui/primitives';

export function PasskeySignIn({ next }: { next: string }): ReactNode {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function signIn(): Promise<void> {
    setPending(true);
    const adapter = browserPasskeys();
    const result = adapter === null
      ? { status: 'error' as const, message: 'Passkey sign-in is not configured.' }
      : await adapter.signIn();
    if (result.status === 'ok') {
      window.location.assign(authContinuePath(next));
      return;
    }
    setMessage(result.message);
    setPending(false);
  }

  return (
    <div style={{ marginBottom: '1rem' }}>
      <Button type="button" onClick={signIn} disabled={pending}>
        {pending ? 'Checking passkey...' : 'Sign in with a passkey'}
      </Button>
      {message === null ? null : <Banner tone="warn">{message}</Banner>}
    </div>
  );
}
