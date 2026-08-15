/**
 * Human labels for the experiment vocabulary, in one place so the list page,
 * the detail page and the form cannot drift apart.
 */
import type {
  ExperimentMetric,
  ExperimentStatus,
  ExperimentType,
} from '@wizard-ads/db';

export const TYPE_LABELS: Record<ExperimentType, string> = {
  bid_push: 'Bid push',
  creative: 'Creative',
  listing_content: 'Listing content',
  price: 'Price',
  placement: 'Placement',
  other: 'Other',
};

export const METRIC_LABELS: Record<ExperimentMetric, string> = {
  acos: 'ACOS',
  cvr: 'Conversion rate',
  ctr: 'Click-through rate',
  sales: 'Sales',
  share: 'Impression share',
};

export const STATUS_LABELS: Record<ExperimentStatus, string> = {
  planned: 'Planned',
  running: 'Running',
  ended: 'Ended',
  analyzed: 'Analyzed',
  aborted: 'Aborted',
};

/**
 * The text colour per status, as whole token references rather than a
 * `var(--wa-${tone}-text)` template composed from a tone name.
 *
 * Two reasons it is a map. The composed string is a high-entropy literal the
 * public-repo hygiene gate flags as a candidate secret, and — the reason worth
 * more — a composed custom-property name cannot be checked against
 * `theme.css`. The old `neutral` tone had no `--wa-neutral-text` to resolve to,
 * so a planned experiment's label silently fell back to inheriting its colour.
 */
export const STATUS_TEXT_COLOR: Record<ExperimentStatus, string> = {
  planned: 'var(--wa-text-muted)',
  running: 'var(--wa-info-text)',
  ended: 'var(--wa-good-text)',
  analyzed: 'var(--wa-good-text)',
  aborted: 'var(--wa-bad-text)',
};

export const EXPERIMENT_TYPE_OPTIONS: ExperimentType[] = [
  'bid_push',
  'creative',
  'listing_content',
  'price',
  'placement',
  'other',
];

export const EXPERIMENT_METRIC_OPTIONS: ExperimentMetric[] = ['acos', 'cvr', 'ctr', 'sales', 'share'];

export const EXPERIMENT_STATUS_OPTIONS: ExperimentStatus[] = [
  'planned',
  'running',
  'ended',
  'analyzed',
  'aborted',
];
