import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '../../src/auth/session';
import { Card, PageHeader } from '../../src/ui/primitives';
import { page } from '../../src/ui/tokens';
import { RecoveryPasswordForm } from './password-form';

export const dynamic = 'force-dynamic';

export default async function RecoverPasswordPage(): Promise<ReactNode> {
  if ((await currentUser()) === null) redirect('/forgot-password?error=link+is+no+longer+valid');
  return (
    <main style={{ ...page, maxWidth: '30rem' }}>
      <PageHeader title="Replace password" subtitle="Choose a new password for this invited account." />
      <Card><RecoveryPasswordForm /></Card>
    </main>
  );
}
