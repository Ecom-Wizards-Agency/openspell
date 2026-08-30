/** `/settings/account` — password login for any organisation member. */
import type { ReactNode } from 'react';
import { authFeatureConfig } from '../../../src/auth/config';
import { gateAccountSecurity } from '../../../src/auth/guard';
import { loadTotpOverview } from '../../../src/auth/totp';
import { safeNextPath } from '../../../src/auth/next-path';
import { gateMessage } from '../../../src/ui/gate-message';
import { Banner, PageHeader } from '../../../src/ui/primitives';
import { Shell } from '../../../src/ui/shell';
import { page } from '../../../src/ui/tokens';
import { PasswordForm } from './password-form';
import { PasskeyManager } from './passkey-manager';
import { TotpManager } from './totp-manager';

export const dynamic = 'force-dynamic';

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<ReactNode> {
  const entry = await gateAccountSecurity();
  if (entry.state !== 'ok') {
    return (
      <main style={page}>
        <PageHeader title="Account" />
        <Banner tone="warn">{gateMessage(entry.state)}</Banner>
      </main>
    );
  }
  if (!entry.context.active) return null;
  const config = authFeatureConfig();
  const totp = config.totpPolicy === 'off' ? null : await loadTotpOverview();
  const next = safeNextPath((await searchParams).next, '/settings/account');

  return (
    <main style={page}>
      <Shell context={entry.context} current="account">
        <PageHeader
          title="Account"
          subtitle="Add a password to your existing account or replace the one you use now."
        />
        <PasswordForm />
        {totp === null ? null : <TotpManager overview={totp} next={next} />}
        {config.passkeyPolicy === 'off' ? null : (
          <PasskeyManager policy={config.passkeyPolicy} />
        )}
      </Shell>
    </main>
  );
}
