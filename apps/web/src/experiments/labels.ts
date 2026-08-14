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

export const STATUS_TONE: Record<ExperimentStatus, 'neutral' | 'info' | 'good' | 'warn' | 'bad'> = {
  planned: 'neutral',
  running: 'info',
  ended: 'good',
  analyzed: 'good',
  aborted: 'bad',
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
