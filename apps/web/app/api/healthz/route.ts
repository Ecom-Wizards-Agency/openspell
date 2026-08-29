import { publicWebHealth } from '../../../src/release/public-revision';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json(
    publicWebHealth({
      vercelGitCommitSha: process.env['VERCEL_GIT_COMMIT_SHA'],
      openspellAppVersion: process.env['OPENSPELL_APP_VERSION'],
      legacyAppVersion: process.env['WIZARD_ADS_APP_VERSION'],
    }),
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    },
  );
}
