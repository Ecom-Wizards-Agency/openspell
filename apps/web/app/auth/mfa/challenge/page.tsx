import type { ReactNode } from 'react';
import { safeNextPath } from '../../../../src/auth/next-path';
import { loadTotpOverview } from '../../../../src/auth/totp';
import { Banner, Card, LinkButton, PageHeader } from '../../../../src/ui/primitives';
import { page } from '../../../../src/ui/tokens';
import { TotpChallengeForm } from './challenge-form';

export const dynamic = 'force-dynamic';

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}): Promise<ReactNode> {
  const next = safeNextPath((await searchParams).next, '/dashboard');
  const overview = await loadTotpOverview();
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title="Verify authenticator" subtitle="Enter the current code from your authenticator app." />
      <Card>
        {overview.status === 'ok' && overview.factors.length > 0 ? (
          <TotpChallengeForm factors={overview.factors} next={next} />
        ) : (
          <>
            <Banner tone="warn">No verified authenticator is available.</Banner>
            <LinkButton href={`/settings/account?mfa=enroll&next=${encodeURIComponent(next)}`}>Account security</LinkButton>
          </>
        )}
      </Card>
    </main>
  );
}
