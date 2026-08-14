/**
 * Exports API: bulk entity snapshots, and the campaign-name join.
 *
 * This closes the first documented gap in `SPAdsApiDataSource`
 * (`_fetch_campaign_metadata` is a stub that returns `{}`): Reporting v3
 * returns dimension ids and no names, and Amazon's own guidance is to pull an
 * export and join by `campaignId`. Without it every campaign in the product is
 * labelled with its numeric id and category classification degrades to
 * "Unknown".
 *
 * The contract below is taken from Amazon's documentation and is NOT
 * live-verified — the reference could not verify it either, which is why the
 * gap existed. `scripts/smoke.ts` exercises it against a real profile; treat
 * anything surprising there as the truth, not this file.
 *
 * Shape-wise an export behaves like a report: POST to mint, GET to poll, a
 * pre-signed URL when it completes, gzipped JSON at the end of it.
 */
import { isRecord, readId, readString } from './read.js';

export type ExportKind = 'campaigns' | 'adGroups' | 'targets' | 'ads';

export interface ExportEndpoint {
  path: string;
  mediaType: string;
}

export const EXPORT_ENDPOINTS: Readonly<Record<ExportKind, ExportEndpoint>> = {
  campaigns: { path: '/campaigns/export', mediaType: 'application/vnd.campaignsexport.v1+json' },
  adGroups: { path: '/adGroups/export', mediaType: 'application/vnd.adgroupsexport.v1+json' },
  targets: { path: '/targets/export', mediaType: 'application/vnd.targetsexport.v1+json' },
  ads: { path: '/ads/export', mediaType: 'application/vnd.adsexport.v1+json' },
};

/**
 * `GET /exports/{exportId}` is NOT versioned separately: live-verified
 * 2026-08-14, the status endpoint 406s on a generic
 * `application/vnd.export.v1+json` and demands the same per-entity media type
 * the create call used (its 406 body enumerates exactly the four
 * `EXPORT_ENDPOINTS` media types). So status polls must know their kind.
 */

export type ExportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ExportMetadata {
  exportId: string;
  status: ExportStatus | string;
  url: string | null;
  urlExpiresAt: string | null;
  fileSize: number | null;
  generatedAt: string | null;
  error: string | null;
}

export function isExportComplete(status: string): boolean {
  return status === 'COMPLETED';
}

export function isExportFailed(status: string): boolean {
  return status === 'FAILED' || status === 'CANCELLED';
}

export interface CreateExportInput {
  kind: ExportKind;
  /** Amazon's ad-product vocabulary, e.g. `SPONSORED_PRODUCTS`. */
  adProducts: readonly string[];
  /** Upper-case entity states. Omitted means "everything Amazon returns". */
  stateFilter?: readonly string[];
}

export function buildExportBody(input: CreateExportInput): Record<string, unknown> {
  const body: Record<string, unknown> = { adProductFilter: [...input.adProducts] };
  if (input.stateFilter !== undefined && input.stateFilter.length > 0) {
    body['stateFilter'] = [...input.stateFilter];
  }
  return body;
}

/**
 * `campaignId -> campaignName`, from a downloaded campaigns export.
 *
 * Returned as a Map rather than a plain object because campaign ids are numeric
 * strings, and a plain object would reorder them into integer-key order the
 * moment anything iterates it.
 */
export function campaignNameIndex(rows: readonly unknown[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = readId(row, 'campaignId');
    const name = readString(row, 'name') ?? readString(row, 'campaignName');
    if (id !== null && name !== null) index.set(id, name);
  }
  return index;
}

/** `adGroupId -> adGroupName`, from a downloaded ad groups export. */
export function adGroupNameIndex(rows: readonly unknown[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = readId(row, 'adGroupId');
    const name = readString(row, 'name') ?? readString(row, 'adGroupName');
    if (id !== null && name !== null) index.set(id, name);
  }
  return index;
}
