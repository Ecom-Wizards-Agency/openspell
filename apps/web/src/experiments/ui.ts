/**
 * Client-safe view helpers for experiments.
 *
 * Kept out of the client components themselves so a server component can call
 * `toUiExperiment` without importing a `'use client'` module, and out of
 * `@wizard-ads/db` so a client component can call `canTransition` without
 * pulling the database client into the browser bundle. Only types cross from
 * `@wizard-ads/db`, and those are erased at compile time.
 */
import type {
  ExperimentMetric,
  ExperimentRecord,
  ExperimentScope,
  ExperimentStatus,
  ExperimentType,
} from '@wizard-ads/db';

export interface UiExperiment {
  id: string;
  profileId: string;
  name: string;
  type: ExperimentType;
  metricFocus: ExperimentMetric;
  status: ExperimentStatus;
  startAt: string;
  endAt: string | null;
  scopeSummary: string;
}

export function scopeSummary(scope: ExperimentScope): string {
  const parts: string[] = [];
  if (scope.campaignIds?.length) parts.push(`${scope.campaignIds.length} campaign(s)`);
  if (scope.adGroupIds?.length) parts.push(`${scope.adGroupIds.length} ad group(s)`);
  if (scope.targetIds?.length) parts.push(`${scope.targetIds.length} keyword/target(s)`);
  if (scope.asins?.length) parts.push(`${scope.asins.length} ASIN(s)`);
  if (scope.searchTerms?.length) parts.push(`${scope.searchTerms.length} search term(s)`);
  return parts.length > 0 ? parts.join(' · ') : 'no entities named';
}

const toIso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

export function toUiExperiment(item: ExperimentRecord): UiExperiment {
  return {
    id: item.id,
    profileId: item.profileId,
    name: item.name,
    type: item.type,
    metricFocus: item.metricFocus,
    status: item.status,
    startAt: toIso(item.startAt),
    endAt: item.endAt ? toIso(item.endAt) : null,
    scopeSummary: scopeSummary(item.scope),
  };
}

/**
 * The status transitions the UI offers. A mirror of the database's own rule
 * (`packages/db` owns the authoritative copy); duplicated here so the client can
 * decide which buttons to show without importing the database layer.
 */
const ALLOWED_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  planned: ['running', 'aborted'],
  running: ['ended', 'aborted'],
  ended: ['analyzed', 'running', 'aborted'],
  analyzed: ['running', 'aborted'],
  aborted: [],
};

export function canTransition(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}
