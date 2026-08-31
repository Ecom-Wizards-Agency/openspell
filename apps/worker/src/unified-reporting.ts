/**
 * Default-off Unified Reporting sidecar.
 *
 * Reporting v3 admits this work only after its own report id and first poll
 * job are durable. Everything after admission runs on a separate queue row and
 * a separate ledger, so no Unified outcome can change v3 status or promotion.
 */
import {
  AdsApiConfigError,
  AdsApiHttpError,
  AdsApiParseError,
  UnifiedReportCreateAmbiguousError,
  type UnifiedReportDefinition,
} from '@wizard-ads/ads-api';
import type {
  UnifiedReportAdvanceJob,
  UnifiedReportOperation,
  UnifiedReportOperationDisposition,
  UnifiedReportRun,
  UnifiedReportRunState,
  WorkerReportType,
} from '@wizard-ads/shared';
import type {
  AdsProfileContext,
  UnifiedReportingClient,
  UnifiedReportMetadata,
} from './ads-api.js';
import type { UnifiedReportingDualRunPolicy } from './deployment-role.js';
import {
  defaultRegionTokenBuckets,
  type RegionTokenBuckets,
} from './region-token-buckets.js';

const MINUTE_MS = 60_000;
const OBSERVATION_HORIZON_MS = 4 * 60 * MINUTE_MS;
const POLL_DELAYS_MINUTES = [5, 10, 20, 30] as const;

export const UNIFIED_CAMPAIGN_OBSERVATION_FIELDS = [
  'advertiserAccount.id',
  'campaign.id',
  'campaign.name',
  'dateRange.value',
  'budgetCurrency.value',
  'metric.impressions',
  'metric.clicks',
  'metric.totalCost',
  'metric.purchases',
  'metric.sales',
] as const;

export interface UnifiedAdmission {
  v3ReportRequestId: string;
  profile: AdsProfileContext;
  reportType: WorkerReportType;
  startDate: string;
  endDate: string;
}

export type UnifiedAdmissionResult =
  | { kind: 'disabled' }
  | { kind: 'profile_not_allowed' }
  | { kind: 'unsupported_report_type' }
  | { kind: 'binding_unavailable' }
  | { kind: 'local_failed' }
  | { kind: 'enqueued'; runId: string; operationId: string; inserted: boolean };

export interface UnifiedDispatch {
  run: UnifiedReportRun;
  operation: UnifiedReportOperation;
  dispatchToken: string;
}

export type UnifiedBeginResult =
  | { kind: 'dispatch'; value: UnifiedDispatch }
  | { kind: 'settled'; runState: UnifiedReportRunState }
  | { kind: 'recovered'; runState: UnifiedReportRunState; successorEnqueued: boolean };

export interface UnifiedSettlement {
  runId: string;
  operationId: string;
  dispatchToken: string;
  now: Date;
  disposition: UnifiedReportOperationDisposition;
  runState: UnifiedReportRunState;
  providerReportId?: string;
  providerStatus?: string;
  providerCode?: string;
  nextRunAt?: Date;
}

type UnifiedDispatchOutcome = Omit<
  UnifiedSettlement,
  'runId' | 'operationId' | 'dispatchToken' | 'now'
>;

type UnifiedPermitResult =
  | { kind: 'complete'; result: Record<string, unknown> }
  | {
      kind: 'settle';
      dispatch: UnifiedDispatch;
      outcome: UnifiedDispatchOutcome;
      providerCalls: 0 | 1;
    };

/** Persistence operations complete state and queue invariants atomically. */
export interface UnifiedDualRunStore {
  admit(input: {
    v3ReportRequestId: string;
    orgId: string;
    profileId: string;
    reportType: 'spCampaigns';
    definitionVersion: 'campaign-observation-v1';
    startDate: string;
    endDate: string;
    observationDeadline: Date;
    now: Date;
  }): Promise<
    | { kind: 'binding_unavailable' }
    | { kind: 'enqueued'; runId: string; operationId: string; inserted: boolean }
  >;
  begin(input: {
    jobId: string;
    payload: UnifiedReportAdvanceJob;
    now: Date;
  }): Promise<UnifiedBeginResult>;
  settle(input: UnifiedSettlement): Promise<{
    runState: UnifiedReportRunState;
    successorEnqueued: boolean;
  }>;
  failTerminal(input: {
    payload: UnifiedReportAdvanceJob;
    reason: string;
    runState: Extract<UnifiedReportRunState, 'paused' | 'local_failed'>;
    now: Date;
  }): Promise<void>;
}

export interface UnifiedDualRun {
  admit(input: UnifiedAdmission): Promise<UnifiedAdmissionResult>;
  advance(input: {
    jobId: string;
    attempts: number;
    profile: AdsProfileContext;
    payload: UnifiedReportAdvanceJob;
  }): Promise<Record<string, unknown>>;
  failTerminal(payload: UnifiedReportAdvanceJob, reason: string): Promise<void>;
}

export interface UnifiedDualRunOptions {
  policy: UnifiedReportingDualRunPolicy;
  store: UnifiedDualRunStore;
  provider: UnifiedReportingClient;
  buckets?: RegionTokenBuckets;
  now?: () => Date;
}

export class WorkerUnifiedDualRun implements UnifiedDualRun {
  private readonly allowedProfiles: ReadonlySet<string>;
  private readonly buckets: RegionTokenBuckets;
  private readonly now: () => Date;

  constructor(private readonly options: UnifiedDualRunOptions) {
    this.allowedProfiles = new Set(options.policy.profileIds);
    this.buckets = options.buckets ?? defaultRegionTokenBuckets;
    this.now = options.now ?? (() => new Date());
  }

  async admit(input: UnifiedAdmission): Promise<UnifiedAdmissionResult> {
    if (!this.options.policy.enabled) return { kind: 'disabled' };
    if (!this.allowedProfiles.has(input.profile.id)) return { kind: 'profile_not_allowed' };
    if (input.reportType !== 'spCampaigns') return { kind: 'unsupported_report_type' };
    const now = this.now();
    return this.options.store.admit({
      v3ReportRequestId: input.v3ReportRequestId,
      orgId: input.profile.orgId,
      profileId: input.profile.id,
      reportType: input.reportType,
      definitionVersion: 'campaign-observation-v1',
      startDate: input.startDate,
      endDate: input.endDate,
      observationDeadline: new Date(now.getTime() + OBSERVATION_HORIZON_MS),
      now,
    });
  }

  async advance(input: {
    jobId: string;
    attempts: number;
    profile: AdsProfileContext;
    payload: UnifiedReportAdvanceJob;
  }): Promise<Record<string, unknown>> {
    if (!this.options.policy.enabled) {
      return { state: 'paused', providerCalls: 0 };
    }
    if (!this.allowedProfiles.has(input.profile.id)) {
      await this.options.store.failTerminal({
        payload: input.payload,
        reason: 'Unified Reporting sidecar profile is no longer admitted by deployment policy',
        runState: 'paused',
        now: this.now(),
      });
      return { state: 'paused', providerCalls: 0 };
    }

    // Acquire provider capacity before the bounded authorization/fence step.
    // A queued permit must not preserve an earlier binding decision, while
    // settlement happens after release so database work cannot starve v3.
    const permitted = await this.buckets.run(
      input.profile.region,
      async (): Promise<UnifiedPermitResult> => {
        const begun = await this.options.store.begin({
          jobId: input.jobId,
          payload: input.payload,
          now: this.now(),
        });
        if (begun.kind !== 'dispatch') {
          return {
            kind: 'complete',
            result: {
              state: begun.runState,
              providerCalls: 0,
              ...(begun.kind === 'recovered'
                ? { recovered: true, successorEnqueued: begun.successorEnqueued }
                : { alreadySettled: true }),
            },
          };
        }

        const { run, operation } = begun.value;
        if (
          run.orgId !== input.payload.orgId ||
          run.profileId !== input.payload.profileId ||
          input.profile.orgId !== input.payload.orgId ||
          operation.runId !== run.id ||
          operation.id !== input.payload.operationId
        ) {
          return {
            kind: 'settle',
            dispatch: begun.value,
            outcome: this.invalidOutcome('local_failed'),
            providerCalls: 0,
          };
        }

        return {
          kind: 'settle',
          dispatch: begun.value,
          outcome: operation.kind === 'create'
            ? await this.createOutcome(input.profile, begun.value)
            : await this.retrieveOutcome(input.profile, begun.value),
          providerCalls: 1,
        };
      },
    );
    if (permitted.kind === 'complete') return permitted.result;
    return this.settle(
      permitted.dispatch,
      permitted.outcome,
      permitted.providerCalls,
    );
  }

  failTerminal(payload: UnifiedReportAdvanceJob, reason: string): Promise<void> {
    return this.options.store.failTerminal({
      payload,
      reason,
      runState: 'local_failed',
      now: this.now(),
    });
  }

  private async createOutcome(
    profile: AdsProfileContext,
    dispatch: UnifiedDispatch,
  ): Promise<UnifiedDispatchOutcome> {
    const definition = campaignObservationDefinition(
      dispatch.run.startDate,
      dispatch.run.endDate,
    );
    try {
      const result = await this.options.provider.createUnifiedReport({
        profile,
        advertiserAccountId: dispatch.run.advertiserAccountId,
        definition,
      });
      if (result.kind === 'refused') {
        return {
          disposition: 'provider_refused',
          runState: 'create_refused',
          providerCode: firstProviderCode(result.codes),
        };
      }
      if (!linkedToExpectedAccount(result.metadata, dispatch.run.advertiserAccountId)) {
        return {
          disposition: 'invalid_response',
          runState: 'local_failed',
        };
      }
      if (result.metadata.status !== 'PENDING') {
        return {
          disposition: 'provider_success',
          runState: 'provider_status_observed',
          providerReportId: result.metadata.reportId,
          providerStatus: result.metadata.status,
        };
      }
      const nextRunAt = addMinutes(this.now(), POLL_DELAYS_MINUTES[0]);
      const beforeDeadline = nextRunAt < new Date(dispatch.run.observationDeadline);
      return {
        disposition: 'provider_success',
        runState: beforeDeadline ? 'observing' : 'observation_horizon_reached',
        providerReportId: result.metadata.reportId,
        providerStatus: result.metadata.status,
        ...(beforeDeadline ? { nextRunAt } : {}),
      };
    } catch (error) {
      if (error instanceof UnifiedReportCreateAmbiguousError) {
        return {
          disposition: 'create_ambiguous',
          runState: 'create_ambiguous',
        };
      }
      if (error instanceof AdsApiHttpError && error.status > 0 && error.status < 500) {
        return {
          disposition: 'provider_refused',
          runState: 'create_refused',
          providerCode: `HTTP_${error.status}`,
        };
      }
      if (error instanceof AdsApiConfigError) {
        return this.invalidOutcome('local_failed');
      }
      if (error instanceof AdsApiParseError) {
        return {
          disposition: 'create_ambiguous',
          runState: 'create_ambiguous',
        };
      }
      // Once the durable fence exists, an unknown create failure is ambiguous
      // even when it may have happened before network I/O. Never replay it.
      return {
        disposition: 'create_ambiguous',
        runState: 'create_ambiguous',
      };
    }
  }

  private async retrieveOutcome(
    profile: AdsProfileContext,
    dispatch: UnifiedDispatch,
  ): Promise<UnifiedDispatchOutcome> {
    const reportId = dispatch.run.providerReportId;
    if (reportId === null) return this.invalidOutcome('local_failed');
    try {
      const result = await this.options.provider.retrieveUnifiedReport({ profile, reportId });
      if (result.kind === 'refused') {
        return {
          disposition: 'provider_refused',
          runState: 'retrieve_refused',
          providerReportId: reportId,
          providerCode: firstProviderCode(result.codes),
        };
      }
      if (result.metadata.reportId !== reportId) {
        return this.invalidOutcome('contract_blocked', reportId);
      }
      if (!linkedToExpectedAccount(result.metadata, dispatch.run.advertiserAccountId)) {
        return this.invalidOutcome('contract_blocked', reportId);
      }
      if (result.metadata.status !== 'PENDING') {
        return {
          disposition: 'provider_success',
          runState: 'provider_status_observed',
          providerReportId: reportId,
          providerStatus: result.metadata.status,
        };
      }
      const nextRunAt = addMinutes(this.now(), pollDelayAfter(dispatch.operation.sequence));
      return {
        disposition: 'provider_success',
        runState: nextRunAt < new Date(dispatch.run.observationDeadline)
          ? 'observing'
          : 'observation_horizon_reached',
        providerReportId: reportId,
        providerStatus: result.metadata.status,
        ...(nextRunAt < new Date(dispatch.run.observationDeadline) ? { nextRunAt } : {}),
      };
    } catch (error) {
      if (error instanceof AdsApiParseError || error instanceof AdsApiConfigError) {
        return this.invalidOutcome('contract_blocked', reportId);
      }
      if (error instanceof AdsApiHttpError && error.status > 0 && error.status < 500 && error.status !== 429) {
        return {
          disposition: 'provider_refused',
          runState: 'retrieve_refused',
          providerReportId: reportId,
          providerCode: `HTTP_${error.status}`,
        };
      }
      const nextRunAt = addMinutes(this.now(), pollDelayAfter(dispatch.operation.sequence));
      return {
        disposition: 'transport_failure',
        runState: nextRunAt < new Date(dispatch.run.observationDeadline)
          ? 'observing'
          : 'observation_horizon_reached',
        providerReportId: reportId,
        ...(nextRunAt < new Date(dispatch.run.observationDeadline) ? { nextRunAt } : {}),
      };
    }
  }

  private invalidOutcome(
    runState: Extract<UnifiedReportRunState, 'contract_blocked' | 'local_failed'>,
    providerReportId?: string,
  ): UnifiedDispatchOutcome {
    return {
      disposition: 'invalid_response',
      runState,
      ...(providerReportId === undefined ? {} : { providerReportId }),
    };
  }

  private async settle(
    dispatch: UnifiedDispatch,
    outcome: UnifiedDispatchOutcome,
    providerCalls: 0 | 1,
  ): Promise<Record<string, unknown>> {
    const settled = await this.options.store.settle({
      runId: dispatch.run.id,
      operationId: dispatch.operation.id,
      dispatchToken: dispatch.dispatchToken,
      now: this.now(),
      ...outcome,
    });
    return {
      state: settled.runState,
      providerCalls,
      disposition: outcome.disposition,
      successorEnqueued: settled.successorEnqueued,
    };
  }
}

export function campaignObservationDefinition(
  startDate: string,
  endDate: string,
): UnifiedReportDefinition {
  return {
    format: 'CSV',
    periods: [{ startDate, endDate }],
    fields: [...UNIFIED_CAMPAIGN_OBSERVATION_FIELDS],
  };
}

function linkedToExpectedAccount(metadata: UnifiedReportMetadata, advertiserAccountId: string): boolean {
  return metadata.linkedAdvertiserAccountIds.length === 1
    && metadata.linkedAdvertiserAccountIds[0] === advertiserAccountId;
}

function firstProviderCode(codes: readonly (string | null)[]): string | undefined {
  const code = codes.find((value): value is string => value !== null && value.trim() !== '');
  return code?.slice(0, 128);
}

function pollDelayAfter(sequence: number): number {
  return POLL_DELAYS_MINUTES[Math.min(sequence, POLL_DELAYS_MINUTES.length - 1)] ?? 30;
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * MINUTE_MS);
}
