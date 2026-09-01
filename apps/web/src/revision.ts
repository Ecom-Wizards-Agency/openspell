const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type WebRevisionSource = 'vercel' | 'explicit' | 'unknown';

export interface WebRevisionIdentity {
  readonly revision: string;
  readonly source: WebRevisionSource;
}

/** Public, non-secret build identity used to bind release evidence to an artifact. */
export function resolveWebRevisionIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WebRevisionIdentity {
  const providerPresent = env['VERCEL_GIT_COMMIT_SHA'] !== undefined;
  const explicitPresent = env['OPENSPELL_WEB_REVISION'] !== undefined;
  const provider = normalizeRevision(env['VERCEL_GIT_COMMIT_SHA']);
  const explicit = normalizeRevision(env['OPENSPELL_WEB_REVISION']);

  if (providerPresent) {
    if (provider === null || (explicitPresent && explicit !== provider)) {
      return { revision: 'unknown', source: 'unknown' };
    }
    return { revision: provider, source: 'vercel' };
  }
  if (explicitPresent && explicit !== null) {
    return { revision: explicit, source: 'explicit' };
  }
  return { revision: 'unknown', source: 'unknown' };
}

export function webRevision(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return resolveWebRevisionIdentity(env).revision;
}

function normalizeRevision(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const revision = raw.trim().toLowerCase();
  return FULL_GIT_SHA.test(revision) ? revision : null;
}
