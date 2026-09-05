import type { DbHandle } from '../client.js';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type RecommendationLaneIntent =
  | Readonly<{ state: 'disabled' }>
  | Readonly<{ state: 'enabled'; revision: string }>
  | Readonly<{ state: 'invalid' }>;

/**
 * Which producer contract a manual preview was admitted under.
 *
 * `legacy` is the pre-cutover compatibility mode: Vercel cron claims
 * `recommendations.run` with the legacy claim protocol, exactly as the deployed
 * `44da7ac` revision did. `fenced` is the narrow recommendation lane with
 * scoped admission at one authorized revision.
 */
export type OptimizerPreviewMode = 'legacy' | 'fenced';

/** Refusals shared by every fenced-mode decision. */
export type RecommendationLaneRefusalReason =
  | 'misconfigured'
  | 'authority_unavailable'
  | 'authority_not_fenced'
  | 'admission_not_scoped'
  | 'revision_mismatch';

/**
 * Manual preview refusals. The two `*_not_legacy` reasons exist so that
 * unsetting the deployment flag after a database cutover fails closed instead
 * of quietly re-enabling the old producer.
 */
export type OptimizerPreviewRefusalReason =
  | RecommendationLaneRefusalReason
  | 'authority_not_legacy'
  | 'admission_not_legacy';

export type OptimizerPreviewReadiness =
  | Readonly<{ ready: true; mode: OptimizerPreviewMode }>
  | Readonly<{ ready: false; reason: OptimizerPreviewRefusalReason }>;

/**
 * Scheduled producers never inherit legacy admission. Absent or `0` intent is
 * `disabled` here even when the database authority is in legacy mode, so the
 * general worker and cron schedulers stay separately opted in.
 */
export type ScheduledRecommendationReadiness =
  | Readonly<{ ready: true; mode: 'fenced' }>
  | Readonly<{ ready: false; reason: 'disabled' | RecommendationLaneRefusalReason }>;

interface RawRecommendationAuthority {
  protocol: unknown;
  admission: unknown;
  epoch: unknown;
  authorized_revision: unknown;
}

type RecommendationAuthorityRow = Readonly<{
  protocol: 'legacy' | 'fenced';
  admission: 'legacy' | 'blocked' | 'scoped';
  epoch: number | string;
  authorized_revision: string | null;
}>;

type RecommendationAuthorityEvidence =
  | Readonly<{ available: true; row: RecommendationAuthorityRow }>
  | Readonly<{ available: false }>;

export function recommendationLaneIntentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecommendationLaneIntent {
  const ready = env['OPENSPELL_RECOMMENDATION_LANE_READY'];
  if (ready === undefined || ready === '0') return { state: 'disabled' };
  if (ready !== '1') return { state: 'invalid' };

  const revision = env['OPENSPELL_RECOMMENDATION_LANE_REVISION'];
  return revision !== undefined && FULL_GIT_SHA.test(revision)
    ? { state: 'enabled', revision }
    : { state: 'invalid' };
}

/**
 * Resolve a manual "Run preview" from fresh deployment intent and database
 * authority. Disabled intent is the legacy fallback, admitted only while the
 * authority is exactly `legacy`/`legacy`; enabled intent keeps the fenced checks.
 */
export async function resolveOptimizerPreviewReadiness(
  handle: Pick<DbHandle, 'sql'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OptimizerPreviewReadiness> {
  const intent = recommendationLaneIntentFromEnv(env);
  if (intent.state === 'invalid') return { ready: false, reason: 'misconfigured' };

  const evidence = await readRecommendationClaimAuthority(handle);
  if (!evidence.available) return { ready: false, reason: 'authority_unavailable' };
  if (intent.state === 'disabled') return legacyReadiness(evidence.row);
  return fencedReadiness(evidence.row, intent.revision);
}

/**
 * Resolve a scheduled producer. This never returns legacy mode: without
 * enabled intent it does no database work and reports `disabled`.
 */
export async function resolveScheduledRecommendationReadiness(
  handle: Pick<DbHandle, 'sql'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ScheduledRecommendationReadiness> {
  const intent = recommendationLaneIntentFromEnv(env);
  if (intent.state === 'disabled') return { ready: false, reason: 'disabled' };
  if (intent.state === 'invalid') return { ready: false, reason: 'misconfigured' };

  const evidence = await readRecommendationClaimAuthority(handle);
  if (!evidence.available) return { ready: false, reason: 'authority_unavailable' };
  return fencedReadiness(evidence.row, intent.revision);
}

export async function enqueueRecommendationSchedulesIfReady(
  handle: Pick<DbHandle, 'sql'>,
  enqueue: () => Promise<number>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const readiness = await resolveScheduledRecommendationReadiness(handle, env);
  return readiness.ready ? enqueue() : 0;
}

export function requireValidRecommendationLaneIntent(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecommendationLaneIntent {
  const intent = recommendationLaneIntentFromEnv(env);
  if (intent.state === 'invalid') {
    throw new Error(
      'OPENSPELL_RECOMMENDATION_LANE_READY and OPENSPELL_RECOMMENDATION_LANE_REVISION are not configured safely',
    );
  }
  return intent;
}

async function readRecommendationClaimAuthority(
  handle: Pick<DbHandle, 'sql'>,
): Promise<RecommendationAuthorityEvidence> {
  try {
    const rows = await handle.sql<RawRecommendationAuthority[]>`
      select protocol, admission, epoch, authorized_revision
        from public.get_recommendation_claim_authority()
    `;
    if (rows.length !== 1) return { available: false };
    const row = rows[0];
    if (row === undefined || !validAuthorityRow(row)) return { available: false };
    return { available: true, row };
  } catch {
    return { available: false };
  }
}

function legacyReadiness(row: RecommendationAuthorityRow): OptimizerPreviewReadiness {
  if (row.protocol !== 'legacy') return { ready: false, reason: 'authority_not_legacy' };
  if (row.admission !== 'legacy') return { ready: false, reason: 'admission_not_legacy' };
  return { ready: true, mode: 'legacy' };
}

function fencedReadiness(
  row: RecommendationAuthorityRow,
  revision: string,
): Readonly<{ ready: true; mode: 'fenced' }>
  | Readonly<{ ready: false; reason: RecommendationLaneRefusalReason }> {
  if (row.protocol !== 'fenced') return { ready: false, reason: 'authority_not_fenced' };
  if (row.admission !== 'scoped') return { ready: false, reason: 'admission_not_scoped' };
  if (row.authorized_revision !== revision) return { ready: false, reason: 'revision_mismatch' };
  return { ready: true, mode: 'fenced' };
}

function validAuthorityRow(row: RawRecommendationAuthority): row is RecommendationAuthorityRow {
  if (row.protocol !== 'legacy' && row.protocol !== 'fenced') return false;
  if (row.admission !== 'legacy' && row.admission !== 'blocked' && row.admission !== 'scoped') {
    return false;
  }
  const epoch = typeof row.epoch === 'number' || typeof row.epoch === 'string'
    ? Number(row.epoch)
    : Number.NaN;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return false;
  return row.authorized_revision === null
    || (typeof row.authorized_revision === 'string' && FULL_GIT_SHA.test(row.authorized_revision));
}
