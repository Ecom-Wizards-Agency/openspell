/**
 * Durable Unified Reporting sidecar contracts.
 *
 * These model local lifecycle and accounting only. Amazon's query definition,
 * wire envelopes, and completed report parts remain owned by `@wizard-ads/ads-api`.
 */
import { z } from 'zod';
import { IsoDate, Uuid } from './primitives.js';
import { WorkerReportType } from './jobs.js';

const nonnegative = z.number().int().nonnegative();
const oneBit = z.number().int().min(0).max(1);
const boundedText = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => value === value.trim(),
  'value must not have surrounding whitespace',
);

/** The only source-defined Unified template admitted in this phase. */
export const UnifiedReportDefinitionVersion = z.enum(['campaign-observation-v1']);
export type UnifiedReportDefinitionVersion = z.infer<typeof UnifiedReportDefinitionVersion>;

/** Local state; provider lifecycle strings are intentionally stored separately. */
export const UnifiedReportRunState = z.enum([
  'create_ready',
  'create_dispatching',
  'observing',
  'create_refused',
  'create_ambiguous',
  'retrieve_refused',
  'provider_status_observed',
  'contract_blocked',
  'observation_horizon_reached',
  'paused',
  'local_failed',
]);
export type UnifiedReportRunState = z.infer<typeof UnifiedReportRunState>;

export const UnifiedReportOperationKind = z.enum(['create', 'retrieve']);
export type UnifiedReportOperationKind = z.infer<typeof UnifiedReportOperationKind>;

export const UnifiedReportOperationState = z.enum(['ready', 'dispatching', 'settled']);
export type UnifiedReportOperationState = z.infer<typeof UnifiedReportOperationState>;

/** Every settled one-input operation chooses exactly one closed disposition. */
export const UnifiedReportOperationDisposition = z.enum([
  'provider_success',
  'provider_refused',
  'create_ambiguous',
  'transport_failure',
  'invalid_response',
  'local_refusal',
  'interrupted_dispatch',
]);
export type UnifiedReportOperationDisposition = z.infer<typeof UnifiedReportOperationDisposition>;

const dispositionCountKey = {
  provider_success: 'providerSuccessCount',
  provider_refused: 'providerRefusedCount',
  create_ambiguous: 'createAmbiguousCount',
  transport_failure: 'transportFailureCount',
  invalid_response: 'invalidResponseCount',
  local_refusal: 'localRefusalCount',
  interrupted_dispatch: 'interruptedDispatchCount',
} as const;

/**
 * One provider batch item is deliberately one durable operation. Before an
 * operation is settled, every outcome count is zero. Once settled, precisely
 * one count is one and it agrees with `disposition`.
 */
export const UnifiedReportOperationAccounting = z.object({
  inputCount: z.literal(1),
  providerSuccessCount: oneBit,
  providerRefusedCount: oneBit,
  createAmbiguousCount: oneBit,
  transportFailureCount: oneBit,
  invalidResponseCount: oneBit,
  localRefusalCount: oneBit,
  interruptedDispatchCount: oneBit,
});
export type UnifiedReportOperationAccounting = z.infer<typeof UnifiedReportOperationAccounting>;

/** Aggregate ledger counts; reconciliation to operation rows is transactional worker work. */
export const UnifiedReportRunAccounting = z.object({
  operationCount: nonnegative,
  settledOperationCount: nonnegative,
  inputCount: nonnegative,
  providerSuccessCount: nonnegative,
  providerRefusedCount: nonnegative,
  createAmbiguousCount: nonnegative,
  transportFailureCount: nonnegative,
  invalidResponseCount: nonnegative,
  localRefusalCount: nonnegative,
  interruptedDispatchCount: nonnegative,
}).superRefine((value, context) => {
  const outcomes = value.providerSuccessCount
    + value.providerRefusedCount
    + value.createAmbiguousCount
    + value.transportFailureCount
    + value.invalidResponseCount
    + value.localRefusalCount
    + value.interruptedDispatchCount;
  if (value.inputCount !== value.operationCount) {
    context.addIssue({ code: 'custom', path: ['inputCount'], message: 'one input is required per operation' });
  }
  if (value.settledOperationCount > value.operationCount) {
    context.addIssue({ code: 'custom', path: ['settledOperationCount'], message: 'settled operations exceed operations' });
  }
  if (outcomes !== value.settledOperationCount) {
    context.addIssue({ code: 'custom', message: 'settled operations must equal closed dispositions' });
  }
});
export type UnifiedReportRunAccounting = z.infer<typeof UnifiedReportRunAccounting>;

/** Explicit operator binding; it is never inferred from an Ads profile/account id. */
export const UnifiedReportingBinding = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  advertiserAccountId: boundedText(256),
  enabled: z.boolean(),
  definitionVersion: UnifiedReportDefinitionVersion,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type UnifiedReportingBinding = z.infer<typeof UnifiedReportingBinding>;

const statesRequiringProviderReportId = new Set<UnifiedReportRunState>([
  'observing',
  'retrieve_refused',
  'provider_status_observed',
  'contract_blocked',
  'observation_horizon_reached',
]);
const statesForbiddingProviderReportId = new Set<UnifiedReportRunState>([
  'create_ready',
  'create_dispatching',
  'create_refused',
  'create_ambiguous',
]);

export const UnifiedReportRun = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  v3ReportRequestId: Uuid,
  bindingId: Uuid,
  advertiserAccountId: boundedText(256),
  reportType: z.literal(WorkerReportType.enum.spCampaigns),
  definitionVersion: UnifiedReportDefinitionVersion,
  startDate: IsoDate,
  endDate: IsoDate,
  state: UnifiedReportRunState,
  providerReportId: boundedText(256).nullable(),
  providerStatus: boundedText(256).nullable(),
  observationDeadline: z.iso.datetime(),
  accounting: UnifiedReportRunAccounting,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  if (value.endDate < value.startDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: 'end date precedes start date' });
  }
  if (statesRequiringProviderReportId.has(value.state) && value.providerReportId === null) {
    context.addIssue({ code: 'custom', path: ['providerReportId'], message: 'state requires a provider report id' });
  }
  if (statesForbiddingProviderReportId.has(value.state) && value.providerReportId !== null) {
    context.addIssue({ code: 'custom', path: ['providerReportId'], message: 'state cannot have a provider report id' });
  }
  if (value.providerStatus !== null && value.providerReportId === null) {
    context.addIssue({ code: 'custom', path: ['providerStatus'], message: 'provider status requires a provider report id' });
  }
  if (value.providerReportId !== null && value.providerStatus === null) {
    context.addIssue({ code: 'custom', path: ['providerStatus'], message: 'provider report id requires an observed status' });
  }
});
export type UnifiedReportRun = z.infer<typeof UnifiedReportRun>;

export const UnifiedReportOperation = z.object({
  id: Uuid,
  orgId: Uuid,
  profileId: Uuid,
  runId: Uuid,
  dispatchJobId: Uuid,
  kind: UnifiedReportOperationKind,
  sequence: nonnegative,
  state: UnifiedReportOperationState,
  disposition: UnifiedReportOperationDisposition.nullable(),
  dispatchToken: Uuid.nullable(),
  dispatchedAt: z.iso.datetime().nullable(),
  settledAt: z.iso.datetime().nullable(),
  providerCode: boundedText(128).nullable(),
  accounting: UnifiedReportOperationAccounting,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((value, context) => {
  const counts = value.accounting;
  const outcomes = counts.providerSuccessCount
    + counts.providerRefusedCount
    + counts.createAmbiguousCount
    + counts.transportFailureCount
    + counts.invalidResponseCount
    + counts.localRefusalCount
    + counts.interruptedDispatchCount;

  if ((value.kind === 'create' && value.sequence !== 0) || (value.kind === 'retrieve' && value.sequence === 0)) {
    context.addIssue({ code: 'custom', path: ['sequence'], message: 'create is sequence zero and retrieves are positive' });
  }
  if (value.state === 'ready') {
    if (value.disposition !== null || value.dispatchToken !== null || value.dispatchedAt !== null || value.settledAt !== null || outcomes !== 0) {
      context.addIssue({ code: 'custom', message: 'ready operation has dispatch or settled evidence' });
    }
    return;
  }
  if (value.state === 'dispatching') {
    if (value.disposition !== null || value.dispatchToken === null || value.dispatchedAt === null || value.settledAt !== null || outcomes !== 0) {
      context.addIssue({ code: 'custom', message: 'dispatching operation must hold only a dispatch fence' });
    }
    return;
  }
  if (value.disposition === null || value.settledAt === null || outcomes !== 1) {
    context.addIssue({ code: 'custom', message: 'settled operation must account exactly one input' });
    return;
  }
  if (value.disposition === 'create_ambiguous' && value.kind !== 'create') {
    context.addIssue({ code: 'custom', path: ['disposition'], message: 'only create can be ambiguous' });
  }
  if (value.disposition === 'interrupted_dispatch' && value.kind !== 'retrieve') {
    context.addIssue({ code: 'custom', path: ['disposition'], message: 'only retrieve dispatch can be interrupted' });
  }
  const expected = dispositionCountKey[value.disposition];
  if (counts[expected] !== 1) {
    context.addIssue({ code: 'custom', path: ['accounting'], message: 'disposition must match its accounting count' });
  }
  if (value.disposition === 'local_refusal') {
    if (value.dispatchToken !== null || value.dispatchedAt !== null) {
      context.addIssue({ code: 'custom', message: 'local refusal cannot claim a provider dispatch' });
    }
  } else if (value.dispatchToken === null || value.dispatchedAt === null) {
    context.addIssue({ code: 'custom', message: 'provider-side settlement requires a dispatch fence' });
  }
});
export type UnifiedReportOperation = z.infer<typeof UnifiedReportOperation>;
