import type { ContextualNegativeExportArtifact } from '@wizard-ads/db';

const CSV_COLUMNS = [
  'proposal_id',
  'profile_id',
  'marketplace_id',
  'campaign_id',
  'ad_group_id',
  'search_term',
  'normalized_query',
  'category',
  'source_group_role',
  'match_type',
  'reason',
  'decision_note',
] as const;

function exportRows(artifact: ContextualNegativeExportArtifact) {
  return artifact.items.map((item) => ({
    proposal_id: item.proposalId,
    profile_id: item.profileId,
    marketplace_id: item.marketplaceId,
    campaign_id: item.campaignId,
    ad_group_id: item.adGroupId,
    search_term: item.searchTerm,
    normalized_query: item.normalizedQuery,
    category: item.category,
    source_group_role: item.sourceGroupRole,
    match_type: item.matchType,
    reason: item.reason,
    decision_note: item.decisionNote,
  }));
}

function csvCell(value: string | null): string {
  const source = value ?? '';
  // Spreadsheet programs may execute formula-looking cells even when spaces,
  // tabs, controls, or invisible formatting code points precede the sigil. A
  // leading apostrophe is the portable CSV convention for forcing literal
  // text; JSON remains exact.
  const text = /^[\s\p{Cc}\p{Cf}]*[=+@-]/u.test(source)
    ? `'${source}`
    : source;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function contextualNegativeExportCsv(
  artifact: ContextualNegativeExportArtifact,
): string {
  const rows = exportRows(artifact).map((row) =>
    CSV_COLUMNS.map((column) => csvCell(row[column])).join(','),
  );
  if (rows.length !== artifact.rowCount) {
    throw new Error(`Contextual export expected ${artifact.rowCount} CSV rows, rendered ${rows.length}`);
  }
  return `${CSV_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
}

export function contextualNegativeExportJson(
  artifact: ContextualNegativeExportArtifact,
): string {
  const rows = exportRows(artifact);
  if (rows.length !== artifact.rowCount) {
    throw new Error(`Contextual export expected ${artifact.rowCount} JSON rows, rendered ${rows.length}`);
  }
  return `${JSON.stringify(
    {
      schema: 'wizard-ads.contextual-negative-export.v1',
      exportId: artifact.id,
      profileId: artifact.profileId,
      marketplaceId: artifact.marketplaceId,
      createdAt: artifact.createdAt.toISOString(),
      note: artifact.note,
      rowCount: artifact.rowCount,
      snapshotSha256: artifact.artifactSha256,
      amazonUpdated: false,
      rows,
    },
    null,
    2,
  )}\n`;
}

export function contextualNegativeExportFilename(
  artifact: ContextualNegativeExportArtifact,
  format: 'csv' | 'json',
): string {
  const date = artifact.createdAt.toISOString().slice(0, 10);
  return `wizard-ads-contextual-negatives-${date}-${artifact.id.slice(0, 8)}.${format}`;
}
