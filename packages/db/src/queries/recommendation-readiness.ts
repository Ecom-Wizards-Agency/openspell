import type { DbHandle } from '../client.js';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type RecommendationLaneIntent =
  | Readonly<{ state: 'disabled' }>
  | Readonly<{ state: 'enabled'; revision: string }>
  | Readonly<{ state: 'invalid' }>;

export type OptimizerPreviewReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{
      ready: false;
      reason:
        | 'disabled'
        | 'misconfigured'
        | 'authority_unavailable'
        | 'authority_not_fenced'
        | 'admission_not_scoped'
        | 'revision_mismatch';
    }>;

interface RawRecommendationAuthority {
  protocol: unknown;
  admission: unknown;
  epoch: unknown;
  authorized_revision: unknown;
}

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

/** Resolve every producer from fresh deployment intent and database authority. */
export async function resolveOptimizerPreviewReadiness(
  handle: Pick<DbHandle, 'sql'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<OptimizerPreviewReadiness> {
  const intent = recommendationLaneIntentFromEnv(env);
  if (intent.state === 'disabled') return { ready: false, reason: 'disabled' };
  if (intent.state === 'invalid') return { ready: false, reason: 'misconfigured' };

  try {
    const rows = await handle.sql<RawRecommendationAuthority[]>`
      select protocol, admission, epoch, authorized_revision
        from public.get_recommendation_claim_authority()
    `;
    if (rows.length !== 1) return { ready: false, reason: 'authority_unavailable' };
    const row = rows[0];
    if (row === undefined || !validAuthorityRow(row)) {
      return { ready: false, reason: 'authority_unavailable' };
    }
    if (row.protocol !== 'fenced') return { ready: false, reason: 'authority_not_fenced' };
    if (row.admission !== 'scoped') return { ready: false, reason: 'admission_not_scoped' };
    if (row.authorized_revision !== intent.revision) {
      return { ready: false, reason: 'revision_mismatch' };
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: 'authority_unavailable' };
  }
}

export async function enqueueRecommendationSchedulesIfReady(
  handle: Pick<DbHandle, 'sql'>,
  enqueue: () => Promise<number>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const readiness = await resolveOptimizerPreviewReadiness(handle, env);
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

function validAuthorityRow(row: RawRecommendationAuthority): row is Readonly<{
  protocol: 'legacy' | 'fenced';
  admission: 'legacy' | 'blocked' | 'scoped';
  epoch: number | string;
  authorized_revision: string | null;
}> {
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
