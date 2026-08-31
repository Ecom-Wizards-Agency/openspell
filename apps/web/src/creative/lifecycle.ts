import type { CreativeSyncJobState } from '@wizard-ads/db';
import type { CreativeSyncSnapshot } from '@wizard-ads/shared';

export type CreativeLifecycleState =
  | 'inactive'
  | 'awaiting_schedule'
  | 'queued'
  | 'mapping_pending'
  | 'mapping_ready'
  | 'report_pending'
  | 'performance_ready'
  | 'completed_empty'
  | 'unsupported'
  | 'blocked';

export interface CreativeLifecycleEvidence {
  producerEligible: boolean;
  latestJob: CreativeSyncJobState | null;
  snapshot: CreativeSyncSnapshot | null;
}

export interface CreativeLifecycleView {
  state: CreativeLifecycleState;
  eyebrow: string;
  title: string;
  body: string;
  observedAt: string | null;
  coverage: string | null;
  counts: Array<{ label: string; value: number }>;
}

type LifecycleBase = Pick<
  CreativeLifecycleView,
  'observedAt' | 'coverage' | 'counts'
>;

const EMPTY_BASE: LifecycleBase = { observedAt: null, coverage: null, counts: [] };

/**
 * Translate producer, queue, and counted ingestion evidence into operator language.
 *
 * A mapping is never described as performance. A completed zero-row report is
 * distinct from an absent sync, and an in-flight refresh keeps the previous
 * observation visible until its replacement reconciles.
 */
export function creativeLifecycle(evidence: CreativeLifecycleEvidence): CreativeLifecycleView {
  const { latestJob, producerEligible, snapshot } = evidence;
  const base = snapshot === null ? EMPTY_BASE : snapshotBase(snapshot);

  if (snapshot === null) {
    if (latestJob !== null) return jobLifecycle(latestJob, base, false);
    if (!producerEligible) {
      return {
        ...EMPTY_BASE,
        state: 'inactive',
        eyebrow: 'Automatic sync inactive',
        title: 'Creative sync is not active for this profile',
        body: 'OpenSpell has not been enabled to inventory Sponsored Brands Video ads and Amazon Asset IDs for this profile.',
      };
    }
    return {
      ...EMPTY_BASE,
      state: 'awaiting_schedule',
      eyebrow: 'Automatic sync ready',
      title: 'Waiting for the first scheduled Creative sync',
      body: 'OpenSpell will queue the first Sponsored Brands Video observation automatically. No manual sync command is required.',
    };
  }

  if (latestJob !== null && latestJob.id !== snapshot.id) {
    return jobLifecycle(latestJob, base, true);
  }
  if (latestJob !== null && (latestJob.status === 'failed' || latestJob.status === 'dead')) {
    return blockedJob(base, true);
  }

  const review = snapshot.legacy + snapshot.unsupported + snapshot.ambiguous + snapshot.unmapped;
  if (snapshot.status === 'blocked') {
    return {
      ...base,
      state: 'blocked',
      eyebrow: 'Attribution blocked',
      title: 'Creative evidence needs review',
      body: 'OpenSpell retained this observation, but did not promote its facts because the mapping or report counts did not reconcile.',
    };
  }
  if (snapshot.status === 'report_pending') {
    return {
      ...base,
      state: 'report_pending',
      eyebrow: 'Report in progress',
      title: 'Asset mappings are ready while performance loads',
      body: 'The authoritative ad-level report is still pending. OpenSpell will not substitute campaign or ad-group totals.',
    };
  }
  if (allAdsUnsupported(snapshot)) {
    return {
      ...base,
      state: 'unsupported',
      eyebrow: 'Unsupported evidence',
      title: 'Amazon returned ads OpenSpell cannot attribute safely',
      body: 'Every observed ad used an unsupported creative shape. OpenSpell retained the counts and promoted no creative performance.',
    };
  }
  if (snapshot.status === 'mapping_only') {
    return {
      ...base,
      state: 'mapping_ready',
      eyebrow: 'Mapping captured',
      title: 'Asset identity is ready; mapped performance is not',
      body: 'OpenSpell observed the current ad-to-asset mapping, but this observation was not eligible for automatic ad-level report attribution.',
    };
  }
  if (snapshot.mappedFactRows === 0) {
    return {
      ...base,
      state: 'completed_empty',
      eyebrow: 'Sync complete',
      title: 'No attributable SB Video performance was returned',
      body: review === 0
        ? 'Amazon returned a complete observation with no ad-level performance in this window.'
        : 'Amazon returned a complete observation, but no ad-level rows could be attributed safely in this window.',
    };
  }
  return {
    ...base,
    state: 'performance_ready',
    eyebrow: 'Performance ready',
    title: `${snapshot.mappedFactRows.toLocaleString('en-US')} ad-level fact row${snapshot.mappedFactRows === 1 ? '' : 's'} promoted`,
    body: 'Performance is attributed only through the observed ad to creative to Amazon Asset ID mapping.',
  };
}

function jobLifecycle(
  job: CreativeSyncJobState,
  base: LifecycleBase,
  hasPreviousEvidence: boolean,
): CreativeLifecycleView {
  if (job.status === 'queued') {
    return {
      ...base,
      state: 'queued',
      eyebrow: hasPreviousEvidence ? 'Refresh queued' : 'Sync queued',
      title: hasPreviousEvidence
        ? 'A new Creative observation is queued'
        : 'The first Creative observation is queued',
      body: hasPreviousEvidence
        ? 'OpenSpell will refresh the ad-to-asset mapping automatically. Previous evidence remains visible until the new observation reconciles.'
        : 'OpenSpell will inventory Sponsored Brands Video ads and Amazon Asset IDs automatically when the report worker claims this job.',
    };
  }
  if (job.status === 'running') {
    return {
      ...base,
      state: 'mapping_pending',
      eyebrow: 'Mapping in progress',
      title: 'OpenSpell is inventorying ads and Amazon Asset IDs',
      body: hasPreviousEvidence
        ? 'The current evidence remains visible while the new observation reconciles.'
        : 'The first automatic observation is running. Performance appears only after the mapping and ad-level report both reconcile.',
    };
  }
  return blockedJob(base, hasPreviousEvidence);
}

function blockedJob(base: LifecycleBase, hasPreviousEvidence: boolean): CreativeLifecycleView {
  return {
    ...base,
    state: 'blocked',
    eyebrow: 'Sync needs review',
    title: 'The latest Creative sync did not produce a current observation',
    body: hasPreviousEvidence
      ? 'OpenSpell retained the previous evidence. Check Sync status before relying on it as current.'
      : 'Check Sync status for the failed or incomplete automatic job. No reconciled Creative observation is available yet.',
  };
}

function snapshotBase(snapshot: CreativeSyncSnapshot): LifecycleBase {
  const review = snapshot.legacy + snapshot.unsupported + snapshot.ambiguous + snapshot.unmapped;
  return {
    observedAt: snapshot.observedAt,
    coverage: snapshot.startDate === snapshot.endDate
      ? snapshot.startDate
      : `${snapshot.startDate} to ${snapshot.endDate}`,
    counts: [
      { label: 'Assets parsed', value: snapshot.parsedAssets },
      { label: 'Ads parsed', value: snapshot.parsedAds },
      { label: 'Mapped ads', value: snapshot.mapped },
      { label: 'Needs review', value: review },
    ],
  };
}

function allAdsUnsupported(snapshot: CreativeSyncSnapshot): boolean {
  return snapshot.parsedAds > 0 && snapshot.unsupported === snapshot.parsedAds;
}
