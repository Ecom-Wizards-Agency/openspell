import type { JobPayload } from '@wizard-ads/shared';
import type { SyncJob } from '../schema/sync.js';

declare const claimTokenBrand: unique symbol;

/** Opaque queue-custody capability issued only by the database. */
export type ClaimToken = string & { readonly [claimTokenBrand]: true };

/** The complete identity needed to settle one fenced attempt. */
export type ClaimRef = Readonly<{
  jobId: string;
  workerId: string;
  token: ClaimToken;
}>;

/** One row of `sync_jobs`, projected without mutable queue internals. */
export interface ClaimedJob {
  id: string;
  orgId: string;
  profileId: string;
  jobType: SyncJob['jobType'];
  payload: JobPayload;
  attempts: number;
  maxAttempts: number;
  dedupeKey: string | null;
  claimedBy: string | null;
  claim: ClaimRef | null;
}

export interface RawClaimedJobRow {
  id: string;
  org_id: string;
  profile_id: string;
  job_type: SyncJob['jobType'];
  payload: JobPayload;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
  claimed_by: string | null;
  claim_token: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function claimToken(value: string): ClaimToken {
  if (!UUID.test(value)) throw new Error('claim function returned an invalid claim capability');
  return value as ClaimToken;
}

/** Parse the one reviewed queue projection used by both fenced workers. */
export function claimedJobFromRaw(row: RawClaimedJobRow): ClaimedJob {
  let claim: ClaimRef | null = null;
  if (row.claim_token !== null) {
    if (row.claimed_by === null) {
      throw new Error('claim function returned incomplete fenced custody');
    }
    claim = Object.freeze({
      jobId: row.id,
      workerId: row.claimed_by,
      token: claimToken(row.claim_token),
    });
  }

  return {
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    jobType: row.job_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    dedupeKey: row.dedupe_key,
    claimedBy: row.claimed_by,
    claim,
  };
}
