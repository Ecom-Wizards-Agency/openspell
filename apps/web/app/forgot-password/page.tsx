import type { ReactNode } from 'react';
import { authFeatureConfig } from '../../src/auth/config';
import { supabaseConfigured } from '../../src/auth/supabase';
import { Banner, Card, LinkButton, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { RecoveryForm } from './recovery-form';

export const dynamic = 'force-dynamic';

export default function ForgotPasswordPage(): ReactNode {
  const enabled = authFeatureConfig().passwordRecovery && supabaseConfigured();
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title="Recover password" subtitle="Request a single-use link for an invited account." />
      <Card>
        {enabled ? (
          <RecoveryForm />
        ) : (
          <Banner tone="warn">Password recovery is not available on this instance.</Banner>
        )}
        <div style={{ marginTop: '1rem' }}>
          <LinkButton href="/login" variant="ghost">Back to sign in</LinkButton>
        </div>
      </Card>
    </main>
  );
}
