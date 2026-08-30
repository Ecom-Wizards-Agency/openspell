import { exactRevision } from './events';

export interface RevisionMetadata {
  revision: string | null;
  rum_evidence: 'diagnostic_only';
}

/** Expose only a validated full SHA; provider metadata never passes through. */
export function publicRevision(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RevisionMetadata {
  return {
    revision: exactRevision(
      environment['VERCEL_GIT_COMMIT_SHA'] ?? environment['OPENSPELL_DEPLOYMENT_REVISION'],
    ),
    rum_evidence: 'diagnostic_only',
  };
}

export function parseRevisionMetadata(value: unknown): RevisionMetadata | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || !Object.hasOwn(record, 'revision')
    || !Object.hasOwn(record, 'rum_evidence')
    || record['rum_evidence'] !== 'diagnostic_only'
  ) return null;
  return { revision: exactRevision(record['revision']), rum_evidence: 'diagnostic_only' };
}
