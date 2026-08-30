import type { CreativeSyncSnapshot } from '@wizard-ads/shared';

export type CreativeLifecycleState =
  | 'not_started'
  | 'mapping_ready'
  | 'report_pending'
  | 'performance_ready'
  | 'completed_empty'
  | 'blocked';

export interface CreativeLifecycleView {
  state: CreativeLifecycleState;
  eyebrow: string;
  title: string;
  body: string;
  observedAt: string | null;
  coverage: string | null;
  counts: Array<{ label: string; value: number }>;
}

/**
 * Translate counted ingestion evidence into operator language.
 *
 * A mapping is never described as performance. A completed zero-row report is
 * distinct from an absent sync, and all review states remain visible.
 */
export function creativeLifecycle(snapshot: CreativeSyncSnapshot | null): CreativeLifecycleView {
  if (snapshot === null) {
    return {
      state: 'not_started',
      eyebrow: 'Sync not started',
      title: 'Creative evidence has not been observed',
      body: 'Run a Creative sync to inventory Sponsored Brands Video ads and their Amazon Asset IDs.',
      observedAt: null,
      coverage: null,
      counts: [],
    };
  }

  const review = snapshot.legacy + snapshot.unsupported + snapshot.ambiguous + snapshot.unmapped;
  const counts = [
    { label: 'Assets parsed', value: snapshot.parsedAssets },
    { label: 'Ads parsed', value: snapshot.parsedAds },
    { label: 'Mapped ads', value: snapshot.mapped },
    { label: 'Needs review', value: review },
  ];
  const base = {
    observedAt: snapshot.observedAt,
    coverage: snapshot.startDate === snapshot.endDate
      ? snapshot.startDate
      : `${snapshot.startDate} to ${snapshot.endDate}`,
    counts,
  };

  if (snapshot.status === 'mapping_only') {
    return {
      ...base,
      state: 'mapping_ready',
      eyebrow: 'Mapping captured',
      title: 'Asset identity is ready; mapped performance is not',
      body: 'OpenSpell observed the current ad-to-asset mapping, but no attributable ad-level report is attached. Legacy rows stay separate below.',
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
  if (snapshot.status === 'blocked') {
    return {
      ...base,
      state: 'blocked',
      eyebrow: 'Attribution blocked',
      title: 'Creative evidence needs review',
      body: 'This observation was retained, but its facts were not promoted because the mapping or report evidence did not reconcile.',
    };
  }
  if (snapshot.mappedFactRows === 0) {
    return {
      ...base,
      state: 'completed_empty',
      eyebrow: 'Sync complete',
      title: 'No attributable SB Video performance was returned',
      body: 'Amazon returned a complete observation with no ad-level rows that OpenSpell could safely attribute in this window.',
    };
  }
  return {
    ...base,
    state: 'performance_ready',
    eyebrow: 'Performance ready',
    title: `${snapshot.mappedFactRows.toLocaleString('en-US')} ad-level fact row${snapshot.mappedFactRows === 1 ? '' : 's'} promoted`,
    body: 'Performance is attributed only through the observed ad → creative → Amazon Asset ID mapping.',
  };
}
