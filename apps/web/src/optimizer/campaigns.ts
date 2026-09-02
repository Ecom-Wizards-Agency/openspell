import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizerCampaignFactRow } from '../../app/_lib/optimizer-campaigns';
import type { ProposalView } from '../recommendations/view';

export interface OptimizerCampaignRow extends OptimizerCampaignFactRow {
  eligibilityReason: string | null;
  groupName: string | null;
  groupRole: string | null;
  lastRunAt: string | null;
  proposals: number;
  selectable: boolean;
}

export type OptimizerPreviewStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface OptimizerPreviewAccepted {
  batchId: string;
  status: 'queued';
  scope: {
    mode: 'all' | 'selected';
    campaignCount: number;
    fingerprint: string;
  };
  childCount: number;
}

export interface OptimizerPreviewChildStatus {
  runId: string;
  groupName: string | null;
  status: OptimizerPreviewStatus;
  campaignCount: number;
  proposalsCount: number;
}

export interface OptimizerPreviewBatchStatus {
  batchId: string;
  status: OptimizerPreviewStatus;
  campaignCount: number;
  proposalsCount: number;
  children: OptimizerPreviewChildStatus[];
}

export function buildOptimizerCampaignRows(
  facts: readonly OptimizerCampaignFactRow[],
  groups: readonly OptimizationGroupRecord[],
  proposals: readonly ProposalView[],
): OptimizerCampaignRow[] {
  const groupById = new Map(groups.map((record) => [record.group.id, record]));
  const proposalCounts = new Map<string, number>();
  for (const proposal of proposals) {
    if (proposal.campaignId === null) continue;
    proposalCounts.set(proposal.campaignId, (proposalCounts.get(proposal.campaignId) ?? 0) + 1);
  }

  return facts.map((campaign) => {
    const record = campaign.groupId === null ? undefined : groupById.get(campaign.groupId);
    const eligibilityReason = campaignEligibilityReason(campaign, record);
    return {
      ...campaign,
      eligibilityReason,
      groupName: record?.group.name ?? null,
      groupRole: record?.group.role ?? null,
      lastRunAt: record?.lastRun?.createdAt ?? null,
      proposals: proposalCounts.get(campaign.campaignId) ?? 0,
      selectable: eligibilityReason === null,
    };
  });
}

function campaignEligibilityReason(
  campaign: OptimizerCampaignFactRow,
  record: OptimizationGroupRecord | undefined,
): string | null {
  if (campaign.state !== 'enabled') return `Campaign state is ${displayState(campaign.state)}.`;
  if (campaign.adProduct !== 'SP') return 'Only Sponsored Products campaigns support bid previews.';
  if (campaign.groupId !== null && record === undefined) {
    return 'The assigned optimization group is unavailable.';
  }
  if (record !== undefined && !record.group.enabled) return 'The assigned optimization group is disabled.';
  return null;
}

function displayState(value: string): string {
  return value.replaceAll('_', ' ').toLocaleLowerCase();
}

export function filterOptimizerCampaignRows(
  rows: readonly OptimizerCampaignRow[],
  input: { query: string; group: string; state: string },
): OptimizerCampaignRow[] {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query !== '' && !`${row.name} ${row.campaignId} ${row.adProduct}`.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (input.group === 'unassigned' && row.groupId !== null) return false;
    if (input.group !== 'all' && input.group !== 'unassigned' && row.groupId !== input.group) return false;
    if (input.state !== 'all' && row.state !== input.state) return false;
    return true;
  });
}

export function parseOptimizerPreviewAccepted(input: unknown): OptimizerPreviewAccepted {
  if (!isObject(input) || typeof input.batchId !== 'string' || input.status !== 'queued'
    || !isObject(input.scope) || !isScopeMode(input.scope.mode)
    || !isPositiveInteger(input.scope.campaignCount)
    || typeof input.scope.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.scope.fingerprint)
    || !isPositiveInteger(input.childCount)) {
    throw new Error('The preview service returned an invalid acceptance response.');
  }
  return {
    batchId: input.batchId,
    status: input.status,
    scope: {
      mode: input.scope.mode,
      campaignCount: input.scope.campaignCount,
      fingerprint: input.scope.fingerprint,
    },
    childCount: input.childCount,
  };
}

export function parseOptimizerPreviewStatus(input: unknown): OptimizerPreviewBatchStatus {
  if (!isObject(input) || typeof input.batchId !== 'string' || !isPreviewStatus(input.status)
    || !isNonNegativeInteger(input.campaignCount)
    || !isNonNegativeInteger(input.proposalsCount)
    || !Array.isArray(input.children)) {
    throw new Error('The preview service returned an invalid status response.');
  }
  const children = input.children.map((child) => {
    if (!isObject(child) || typeof child.runId !== 'string'
      || !(child.groupName === null || typeof child.groupName === 'string')
      || !isPreviewStatus(child.status)
      || !isPositiveInteger(child.campaignCount)
      || !isNonNegativeInteger(child.proposalsCount)) {
      throw new Error('The preview service returned an invalid child status.');
    }
    return {
      runId: child.runId,
      groupName: child.groupName,
      status: child.status,
      campaignCount: child.campaignCount,
      proposalsCount: child.proposalsCount,
    };
  });
  return {
    batchId: input.batchId,
    status: input.status,
    campaignCount: input.campaignCount,
    proposalsCount: input.proposalsCount,
    children,
  };
}

export function optimizerPreviewError(input: unknown, fallback: string): string {
  return isObject(input) && typeof input.error === 'string' && input.error.trim() !== ''
    ? input.error
    : fallback;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function isScopeMode(input: unknown): input is 'all' | 'selected' {
  return input === 'all' || input === 'selected';
}

function isPreviewStatus(input: unknown): input is OptimizerPreviewStatus {
  return input === 'queued' || input === 'running' || input === 'succeeded' || input === 'failed';
}

function isPositiveInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isInteger(input) && input > 0;
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === 'number' && Number.isInteger(input) && input >= 0;
}
