/**
 * The three files an export batch produces, rendered from what was recorded.
 *
 *   ?format=rows   the rows JSON `batches.py` consumes, byte-for-byte
 *   ?format=caps   the caps + target ACOS that run's `validate` needs, with the
 *                  command line already assembled
 *   ?format=xlsx   the Bulk Operations workbook
 *
 * Nothing here re-decides anything: the batch already exists, so the same URL
 * fetched twice gives the same bytes. That is the difference between an export
 * and a download, and it is why the rows JSON is generated from `apply_rows`
 * rather than from the proposals — the ledger is the record, the proposal table
 * is where the record came from.
 */
import { getExportBatch, getRecommendationRun } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  requestActor,
  requireOrgMembership,
} from '../../../../../src/server/request-context';
import {
  buildBulkWorkbook,
  capsConfig,
  exportFilenames,
  serializeApplyRows,
  serializeCapsConfig,
} from '../../../../../src/recommendations/export';
import type { BulkProposal } from '../../../../../src/recommendations/export';
import { resolveExportCaps } from '../../../../../src/recommendations/strategy';

export const runtime = 'nodejs';

const FORMATS = ['rows', 'caps', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

function attachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ batchId: string }> },
): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);

    const { batchId } = await context.params;
    const requested = new URL(request.url).searchParams.get('format') ?? 'rows';
    if (!(FORMATS as readonly string[]).includes(requested)) {
      throw new Error(`format must be one of: ${FORMATS.join(', ')}`);
    }
    const format = requested as Format;

    const batch = await getExportBatch(database, { orgId: actor.orgId, batchId });
    if (batch === null) throw new Error('Not found');
    const files = exportFilenames(batch.tag);

    if (format === 'rows') {
      return new Response(serializeApplyRows(batch.rows), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': attachment(files.rows),
        },
      });
    }

    if (format === 'caps') {
      // The caps come from the run's own strategy snapshot, not from today's
      // document: a batch validated against thresholds it was never computed
      // under is a check that proves nothing.
      const runId = batch.proposals[0]?.runId ?? null;
      const run = runId === null ? null : await getRecommendationRun(database, { orgId: actor.orgId, runId });
      const caps = resolveExportCaps(run?.strategySnapshot ?? null, batch.optGroup);
      const config = capsConfig({
        tag: batch.tag,
        optGroup: batch.optGroup,
        lever: batch.lever,
        maxIncrease: caps.maxIncrease,
        maxDecrease: caps.maxDecrease,
        targetAcos: caps.targetAcos,
      });
      return new Response(serializeCapsConfig(config), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': attachment(files.caps),
        },
      });
    }

    const proposals: BulkProposal[] = batch.proposals.map((proposal) => ({
      entityType: proposal.entityType,
      entityId: proposal.entityId,
      entityName: proposal.entityName,
      field: proposal.field,
      proposedValue: proposal.proposedValue,
      campaignId: proposal.campaignId,
      adGroupId: proposal.adGroupId,
      portfolioId: proposal.campaignPortfolioId,
      campaignKnown: proposal.campaignKnown,
    }));
    const workbook = buildBulkWorkbook(proposals);
    return new Response(new Uint8Array(workbook.bytes), {
      headers: {
        'content-type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': attachment(files.workbook),
        // Rows that could not be written are a fact the caller has to see, and
        // a binary body has nowhere to put it.
        'x-wizard-ads-skipped-rows': String(workbook.warnings.length),
      },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
