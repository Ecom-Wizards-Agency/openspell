/** `/settings/account` — password login for any organisation member. */
import type { ReactNode } from 'react';
import { gate } from '../../../src/auth/guard';
import { gateMessage } from '../../../src/ui/gate-message';
import { Banner, PageHeader } from '../../../src/ui/primitives';
import { Shell } from '../../../src/ui/shell';
import { page } from '../../../src/ui/tokens';
import { PasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

export default async function AccountPage(): Promise<ReactNode> {
  const entry = await gate();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Account" />
        <Banner tone="warn">{gateMessage(entry.state)}</Banner>
      </main>
    );
  }
  if (!entry.context.active) return null;

  return (
    <main style={page}>
      <Shell context={entry.context} current="account">
        <PageHeader
          title="Account"
          subtitle="Add a password to your existing account or replace the one you use now."
        />
        <PasswordForm />
      </Shell>
    </main>
  );
}
