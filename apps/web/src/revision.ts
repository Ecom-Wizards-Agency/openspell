/** Public, non-secret build identity used to bind release evidence to an artifact. */
export function webRevision(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env['OPENSPELL_WEB_REVISION'] ?? env['VERCEL_GIT_COMMIT_SHA'] ?? '';
  const revision = raw.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(revision) ? revision : 'unknown';
}
