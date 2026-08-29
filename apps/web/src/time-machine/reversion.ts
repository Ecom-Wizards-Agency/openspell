/** Pure presentation helpers for Time Machine reversion exports. */

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function reversionBatchTag(input: {
  sourceTag: string;
  sourceBatchId: string;
  exportedAt: Date;
}): string {
  const source = input.sourceTag.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');
  const suffix = input.sourceBatchId.replaceAll('-', '').slice(0, 8);
  return `${source || 'batch'}-revert-${compactTimestamp(input.exportedAt)}-${suffix}`;
}
