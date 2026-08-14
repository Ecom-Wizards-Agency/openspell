/**
 * Submit a bug or a feature request.
 *
 * The page the reporter came from arrives as `?from=`, put there by the header
 * entry point, and the profile they had selected as `?profile=`. Both are
 * normalised on the server before the form ever shows them, so what the user
 * is asked to approve is exactly what will be stored.
 */
import { headers } from 'next/headers';
import { openWebDatabase, requestActor } from '../../../src/server/request-context';
import { requireOrgRole } from '../../../src/server/org-role';
import { pageContext } from '../../../src/feedback/page-context';
import { page, heading, muted } from '../../../src/ui/tokens';
import { SubmitFeedbackForm } from './submit-form';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export default async function NewFeedbackPage({ searchParams }: { searchParams: SearchParams }) {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(await headers());
    await requireOrgRole(database, actor);
    const query = await searchParams;
    const context = pageContext({
      route: single(query['from']),
      profileId: single(query['profile']),
      appVersion: process.env['WIZARD_ADS_APP_VERSION'] ?? null,
      actorType: 'user',
    });
    return <SubmitFeedbackForm context={context} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Feedback is unavailable';
    return (
      <main style={page}>
        <h1 style={heading}>Feedback</h1>
        <p role="alert">{message}</p>
        <p style={muted}>Sign in to file a bug report or a feature request.</p>
      </main>
    );
  } finally {
    await database.close();
  }
}
