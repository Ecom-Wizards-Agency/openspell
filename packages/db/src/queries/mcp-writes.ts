import { createHash, randomUUID } from 'node:crypto';
import { Uuid } from '@wizard-ads/shared';
import { SpWriteActor } from '@wizard-ads/shared/sp-write-application';
import { McpKeyTokenDigest, McpWriteKeyIssueRequest, McpWriteKeySummary } from '@wizard-ads/shared/mcp-writes';
import {
  McpWriteDelegation, serializeMcpWriteDelegationFingerprint, verifyMcpWriteDelegationFingerprint,
} from '@wizard-ads/shared/sp-writes';
import type { DbHandle } from '../client.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { SpWriteApplicationError } from './sp-write-errors.js';

const hasher = { algorithm: 'sha256' as const,
  digest: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex') };

function refuse(error: unknown): never {
  if (error instanceof SpWriteApplicationError) throw error;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === '42501') throw new SpWriteApplicationError('authorization_refused');
  if (code === '22023' || code === '22P02' || code === '22003') throw new SpWriteApplicationError('invalid_request');
  if (code === '23505') throw new SpWriteApplicationError('identity_conflict');
  throw new SpWriteApplicationError('outcome_unknown');
}

/** The caller is the authenticated operator server. No bearer or actor comes from policy input. */
export async function issueMcpWriteDelegation(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, rawRequest: McpWriteKeyIssueRequest,
  rawDigest: McpKeyTokenDigest,
): Promise<McpWriteDelegation> {
  const actor = SpWriteActor.safeParse(rawActor);
  const request = McpWriteKeyIssueRequest.safeParse(rawRequest);
  const digest = McpKeyTokenDigest.safeParse(rawDigest);
  if (!actor.success || !request.success || !digest.success) throw new SpWriteApplicationError('invalid_request');
  try {
    return await withAuthenticatedActor(handle, actor.data, async (sql) => {
      // These are inputs to the artifact, not an authorization decision. The RPC
      // locks and rechecks membership, ownership and currency in its own order.
      const profiles = await sql<{ profile_id: string; currency_code: string }[]>`
        select id as profile_id, currency_code from public.ad_profiles where org_id = ${actor.data.orgId}
          and id = any(${sql.array(request.data.profileIds)}::uuid[]) order by id
      `;
      if (profiles.length !== request.data.profileIds.length) throw new SpWriteApplicationError('authorization_refused');
      const [clock] = await sql<{ issued_at: string }[]>`
        select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as issued_at
      `;
      const parsed = McpWriteDelegation.safeParse({ schemaVersion: 'openspell.mcp-write-delegation.v1',
        versionId: randomUUID(), keyId: randomUUID(), keyLabel: request.data.label,
        orgId: actor.data.orgId, issuerUserId: actor.data.userId,
        profiles: profiles.map((profile) => ({ profileId: profile.profile_id, currencyCode: profile.currency_code })),
        issuedAt: clock?.issued_at, expiresAt: request.data.expiresAt, limits: request.data.limits, fingerprint: '0'.repeat(64) });
      if (!parsed.success) throw new SpWriteApplicationError('invalid_request');
      const preimage = serializeMcpWriteDelegationFingerprint(parsed.data);
      const delegation = { ...parsed.data, fingerprint: hasher.digest(preimage) };
      const result = await sql<{ artifact: unknown }[]>`select app.issue_mcp_write_key_v1(
        ${JSON.stringify(delegation)}, ${preimage}, ${digest.data.tokenHash}, ${digest.data.keyPrefix}
      ) as artifact`;
      if (result.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
      const saved = verifyMcpWriteDelegationFingerprint(result[0]?.artifact, hasher);
      if (JSON.stringify(saved) !== JSON.stringify(delegation)) throw new SpWriteApplicationError('outcome_unknown');
      return saved;
    });
  } catch (error) { return refuse(error); }
}

/** Recorded authority remains inspectable after key revocation or expiry. No token/hash is selected. */
export async function listMcpWriteDelegations(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor,
): Promise<McpWriteKeySummary[]> {
  const actor = SpWriteActor.parse(rawActor);
  const rows = await handle.sql<{ artifact_text: string; revoked_at: string | null; last_used_at: string | null }[]>`
    select d.artifact_text,
      to_char(k.revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as revoked_at,
      to_char(k.last_used_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_used_at
    from mcp.write_delegations d join mcp.api_keys k on k.org_id = d.org_id and k.id = d.key_id
    join public.org_members m on m.org_id = d.org_id and m.user_id = ${actor.userId} and m.role in ('owner','admin')
    where d.org_id = ${actor.orgId} order by d.issued_at desc, d.version_id desc
  `;
  return rows.map((row) => McpWriteKeySummary.parse({
    delegation: verifyMcpWriteDelegationFingerprint(JSON.parse(row.artifact_text), hasher),
    revokedAt: row.revoked_at, lastUsedAt: row.last_used_at,
  }));
}

export async function revokeMcpKeyAsOperator(
  handle: Pick<DbHandle, 'sql'>, rawActor: SpWriteActor, keyId: string,
): Promise<boolean> {
  const actor = SpWriteActor.safeParse(rawActor); const key = Uuid.safeParse(keyId);
  if (!actor.success || !key.success) throw new SpWriteApplicationError('invalid_request');
  try {
    return await withAuthenticatedActor(handle, actor.data, async (sql) => {
      const result = await sql<{ revoked: boolean }[]>`select app.revoke_mcp_key_v1(${actor.data.orgId}, ${key.data}) as revoked`;
      if (result.length !== 1 || typeof result[0]?.revoked !== 'boolean') throw new SpWriteApplicationError('outcome_unknown');
      return result[0].revoked;
    });
  } catch (error) { return refuse(error); }
}
