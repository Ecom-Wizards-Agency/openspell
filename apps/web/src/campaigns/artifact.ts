/**
 * One server-side build boundary for the Campaign Builder's two modes.
 *
 * The browser submits JSON. This module turns it into either the CREATE plan
 * already owned by `@wizard-ads/campaigns`, or WP-50's UPDATE diff against a
 * server-loaded entity snapshot. Both paths return the exact rows shown in
 * preflight and project those same rows to XLSX; export never recomputes a
 * second representation behind the operator's review.
 */
import {
  buildCampaignPlan,
  buildCampaignUpdate,
  preflight,
  toBulkRows,
  toBulkWorkbook,
  toUpdateBulkWorkbook,
  type BulkRow,
  type CampaignBuildConfig,
  type CampaignUpdateChanges,
  type WorkbookExport,
} from '@wizard-ads/campaigns';
import type { EntityRow } from '@wizard-ads/shared';

export type CampaignBuilderMode = 'create' | 'update';

export interface CampaignBuilderContext {
  today: string;
  /** The selected profile label; UPDATE filenames come from trusted roster data. */
  client: string;
  marketplace: string;
  entities?: readonly EntityRow[];
}

export interface CampaignBuilderPreview {
  mode: CampaignBuilderMode;
  ready: boolean;
  exportable: boolean;
  issues: string[];
  notes: string[];
  review: string[];
  rows: BulkRow[];
  counts: { update: number; archive: number; create: number };
}

export interface CampaignBuilderArtifact {
  preview: CampaignBuilderPreview;
  workbook: WorkbookExport | null;
}

interface UpdateJsonConfig {
  allowEndDateClear?: boolean;
  changes: CampaignUpdateChanges;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function createConfig(value: unknown): CampaignBuildConfig {
  const input = record(value, 'CREATE config');
  if (!Array.isArray(input['campaigns'])) throw new Error('CREATE config needs campaigns[]');
  record(input['defaults'], 'CREATE config defaults');
  record(input['naming'], 'CREATE config naming');
  return value as CampaignBuildConfig;
}

function updateConfig(value: unknown): UpdateJsonConfig {
  const input = record(value, 'UPDATE config');
  const changes = record(input['changes'], 'UPDATE config changes');
  return {
    allowEndDateClear: input['allowEndDateClear'] === true,
    changes: changes as CampaignUpdateChanges,
  };
}
function operationCounts(rows: readonly BulkRow[]): CampaignBuilderPreview['counts'] {
  const counts = { update: 0, archive: 0, create: 0 };
  for (const row of rows) {
    if (row.Operation === 'Update') counts.update += 1;
    else if (row.Operation === 'Archive') counts.archive += 1;
    else if (row.Operation === 'Create') counts.create += 1;
  }
  return counts;
}

/** Build the preview and, only when it is exportable, its matching workbook. */
export function buildCampaignBuilderArtifact(
  mode: CampaignBuilderMode,
  configValue: unknown,
  context: CampaignBuilderContext,
): CampaignBuilderArtifact {
  if (mode === 'create') {
    const config = createConfig(configValue);
    const result = preflight(config, context.today);
    const plan = result.ready ? buildCampaignPlan(config, { today: context.today }) : null;
    const rows = plan === null ? [] : toBulkRows(plan);
    const preview: CampaignBuilderPreview = {
      mode,
      ready: result.ready,
      exportable: result.ready && rows.length > 0,
      issues: result.issues,
      notes: result.notes,
      review: plan === null ? [] : plan.campaigns.map((campaign) => `CREATE Campaign ${campaign.name}`),
      rows,
      counts: operationCounts(rows),
    };
    return { preview, workbook: plan === null ? null : toBulkWorkbook(plan) };
  }

  const config = updateConfig(configValue);
  if (context.entities === undefined) {
    throw new Error('UPDATE mode needs a selected synced profile');
  }
  const result = buildCampaignUpdate(config.changes, context.entities, {
    allowEndDateClear: config.allowEndDateClear,
  });
  const preview: CampaignBuilderPreview = {
    mode,
    ready: result.errors.length === 0,
    exportable: result.errors.length === 0 && result.rows.length > 0,
    issues: result.errors,
    notes: result.review.filter((line) => line.startsWith('SKIPPED')),
    review: result.review,
    rows: result.rows,
    counts: operationCounts(result.rows),
  };
  return {
    preview,
    workbook: preview.exportable
      ? toUpdateBulkWorkbook(result.rows, {
          client: context.client,
          marketplace: context.marketplace,
          today: context.today,
        })
      : null,
  };
}
