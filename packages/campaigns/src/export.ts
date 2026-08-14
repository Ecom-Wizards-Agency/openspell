/**
 * The two things a plan leaves as: a bulk-upload workbook and a JSON document.
 *
 * Both are files. Neither uploads anything, and nothing in this package can:
 * creating campaigns through the Ads API is WP-14b, behind its own gate and
 * its own operator approval. The safety posture is inherited from the
 * reference toolkit and is worth restating because it is the whole reason a
 * generated campaign is safe to hand over: **campaigns default to paused**, so
 * a file uploaded by accident spends nothing.
 */
import { planToRows, planToSheet } from './plan.js';
import type { BulkRow, CampaignPlan, SheetModel } from './types.js';
import { writeWorkbook } from './xlsx/index.js';

export interface WorkbookExport {
  /** A suggested file name. The caller owns where it lands. */
  filename: string;
  bytes: Uint8Array;
  /** The same content as a grid, for a diff that does not go through a file. */
  sheet: SheetModel;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The reference's file-name convention: date, brand, marketplace, what it is. */
export function bulkFilename(plan: CampaignPlan): string {
  const brand = slug(plan.client) || 'campaigns';
  const marketplace = plan.marketplace || 'US';
  return `${plan.today}_${brand}_${marketplace}_SP_bulk_campaigns.xlsx`;
}

/** A plan to bulk-upload workbook bytes. */
export function toBulkWorkbook(plan: CampaignPlan): WorkbookExport {
  const sheet = planToSheet(plan);
  return { filename: bulkFilename(plan), bytes: writeWorkbook(sheet), sheet };
}

/** A plan to its bulk rows, keyed by Amazon column name. */
export function toBulkRows(plan: CampaignPlan): BulkRow[] {
  return planToRows(plan);
}

/** A plan as JSON. Stable key order, two-space indent, trailing newline. */
export function toPlanJson(plan: CampaignPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/**
 * A one-line-per-campaign summary, the way the reference previews a build.
 *
 * Counting the targets rather than restating them is the point: an operator
 * scanning this is checking that a campaign has any targets at all and that
 * the budget is the one they expected.
 */
export function summarizePlan(plan: CampaignPlan): string[] {
  return plan.campaigns.map((campaign) => {
    const targets = campaign.targetingType === 'AUTO'
      ? '4 auto groups'
      : campaign.campaignType === 'PAT'
        ? `${campaign.adGroup.productTargets.length} product target(s)`
        : `${campaign.adGroup.keywords.length} keyword(s)`;
    const negatives = campaign.adGroup.negativeKeywords.length
      + campaign.negativeKeywords.length
      + campaign.adGroup.negativeProductTargets.length;
    const negativeNote = negatives > 0 ? `, ${negatives} negative(s)` : '';
    return `${campaign.name}\n`
      + `    ${campaign.campaignType} · ${campaign.targetingType} · ${campaign.state} · `
      + `budget ${campaign.dailyBudget.toFixed(2)} · bid ${campaign.adGroup.defaultBid.toFixed(2)} · `
      + `${campaign.biddingStrategyLabel} · ${targets}${negativeNote}`;
  });
}
