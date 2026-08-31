import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import {
  CONTEXTUAL_NEGATIVE_ACTION_LIMIT,
  CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT,
  CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT,
  ContextualNegativeReviewConflictError,
  ContextualNegativeReviewLockTimeoutError,
  ContextualNegativeReviewStateError,
  ContextualNegativeReviewValidationError,
  contextualNegativeReviewFingerprint,
  contextualNegativeReviewScopeLockKeys,
  countContextualNegativeCsvRecords,
  decideContextualNegativeProposals,
  exportAcceptedContextualNegatives,
  getContextualNegativeExport,
  listContextualNegativeExports,
  loadContextualNegativeReview,
  serializeContextualNegativeExportCsv,
  serializeContextualNegativeExportJson,
  type ContextualNegativeExportEnvelope,
  type ContextualNegativeExportProposalSnapshot,
} from './contextual-negative-review.js';
import { persistContextualNegativeProposals } from './sqp.js';

const available = await databaseAvailable();
const OWNER_A = '86868686-8686-4686-8686-868686868686';
const OWNER_B = '87878787-8787-4787-8787-878787878787';
const ANALYST_A = '88888888-8888-4888-8888-888888888888';
const MARKETPLACE = 'review-marketplace';

const fingerprintInput = {
  orgId: '11111111-1111-4111-8111-111111111111',
  id: '22222222-2222-4222-8222-222222222222',
  profileId: '33333333-3333-4333-8333-333333333333',
  marketplaceId: 'marketplace-synthetic',
  campaignId: 'campaign-synthetic',
  adGroupId: 'ad-group-synthetic',
  searchTerm: 'Search, "quoted"\n=SUM(A1:A2) ☃',
  normalizedQuery: 'search, "quoted"\n=sum(a1:a2) ☃',
  category: 'excluded' as const,
  sourceGroupRole: 'profit' as const,
  matchType: 'negative_exact' as const,
  reason: 'Reviewed → offline only.',
  status: 'accepted' as const,
};

describe('contextual-negative frozen encodings', () => {
  it('freezes the semantic fingerprint and changes for every covered field', () => {
    const baseline = contextualNegativeReviewFingerprint(fingerprintInput);
    expect(baseline).toBe('d764c9ea039d7cfac696e00d70d3004eebd294cab3da110a4672f92ddd77b2b7');
    for (const field of Object.keys(fingerprintInput) as Array<keyof typeof fingerprintInput>) {
      const changed = { ...fingerprintInput, [field]: `${fingerprintInput[field]}-changed` };
      expect(contextualNegativeReviewFingerprint(changed as typeof fingerprintInput), field)
        .not.toBe(baseline);
    }
  });

  it('freezes JSON/CSV bytes, UUID order, formula hardening, Unicode, and record counts', () => {
    const first: ContextualNegativeExportProposalSnapshot = {
      ...fingerprintInput,
      reviewFingerprint: contextualNegativeReviewFingerprint(fingerprintInput),
    };
    const secondInput = {
      ...fingerprintInput,
      id: '11111111-2222-4222-8222-222222222222',
      searchTerm: '\u2007@danger',
      normalizedQuery: '+danger',
      reason: 'line one\r\nline two',
    };
    const second: ContextualNegativeExportProposalSnapshot = {
      ...secondInput,
      reviewFingerprint: contextualNegativeReviewFingerprint(secondInput),
    };
    const proposals = [second, first].sort((left, right) => left.id.localeCompare(right.id));
    const envelope: ContextualNegativeExportEnvelope = {
      version: 1,
      exportId: '44444444-4444-4444-8444-444444444444',
      orgId: fingerprintInput.orgId,
      profileId: fingerprintInput.profileId,
      marketplaceId: fingerprintInput.marketplaceId,
      note: 'Frozen synthetic export.',
      createdAt: '2026-09-01T00:00:00.000Z',
      rowCount: 2,
      amazonUpdated: false,
      proposals,
    };
    const jsonBytes = serializeContextualNegativeExportJson(envelope);
    const csvBytes = serializeContextualNegativeExportCsv(proposals);
    expect(createHash('sha256').update(jsonBytes).digest('hex'))
      .toBe('e3ae5c0f2a9d7c4aa8e011d86bf26e033bfd9e59c9dc28bb52fbe66fe14f5655');
    expect(createHash('sha256').update(csvBytes).digest('hex'))
      .toBe('12052d45f86f0b7cf7efcf7ca8a71dc22e0ee87d6967fb38aad00663e5741949');
    expect(jsonBytes.at(0)).not.toBe(0xef);
    expect(jsonBytes.at(-1)).toBe(0x0a);
    expect(csvBytes.at(0)).not.toBe(0xef);
    expect(csvBytes.at(-1)).toBe(0x0a);
    expect(csvBytes.toString('utf8')).toContain("'\u2007@danger");
    expect(csvBytes.toString('utf8')).toContain("'+danger");
    expect(csvBytes.toString('utf8')).toContain('"line one\r\nline two"');
    expect(countContextualNegativeCsvRecords(csvBytes)).toBe(3);
  });
});

describe.skipIf(!available)('contextual-negative review and immutable exports', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';
  let proposalIds: string[] = [];
  let foreignProposalId = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp182_review');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-a', ${OWNER_A}::uuid, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-b', ${OWNER_B}::uuid, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [aProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA}::uuid limit 1
    `;
    const [bProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB}::uuid limit 1
    `;
    profileA = aProfile?.id ?? '';
    profileB = bProfile?.id ?? '';
    await database.sql`select public.auth_user_stub(${ANALYST_A}::uuid)`;
    await database.sql`
      insert into public.org_members (org_id, user_id, role)
      values (${orgA}::uuid, ${ANALYST_A}::uuid, 'analyst')
    `;

    const proposals = await database.sql<{ id: string; ordinal: number }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      select ${orgA}::uuid, ${profileA}::uuid, ${MARKETPLACE},
             'campaign-' || source.ordinal, 'ad-group-' || source.ordinal,
             'Synthetic query ' || source.ordinal,
             'synthetic query ' || source.ordinal,
             'excluded', 'profit', 'negative_exact',
             'Synthetic exclusion reviewed at ad-group level.'
        from generate_series(1, 302) as source(ordinal)
      returning id, substring(campaign_id from '[0-9]+')::int as ordinal
    `;
    proposalIds = proposals.sort((left, right) => left.ordinal - right.ordinal).map((row) => row.id);
    const [foreign] = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      values (
        ${orgB}::uuid, ${profileB}::uuid, ${MARKETPLACE}, 'foreign-campaign',
        'foreign-group', 'Foreign query', 'foreign query', 'excluded',
        'profit', 'negative_exact', 'Foreign synthetic proposal.'
      )
      returning id
    `;
    foreignProposalId = foreign?.id ?? '';
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  async function expectations(ids: readonly string[]) {
    const loaded = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    if (loaded.status !== 'ready') throw new Error('review fixture unexpectedly exceeded capacity');
    const byId = new Map(loaded.proposals.map((row) => [row.id, row.reviewFingerprint] as const));
    return ids.map((id) => ({ id, expectedFingerprint: byId.get(id) ?? '0'.repeat(64) }));
  }

  it('loads all 302 rows with exact status counts and no silent truncation', async () => {
    const loaded = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(loaded).toMatchObject({
      status: 'ready',
      rowCount: 302,
      statusCounts: { total: 302, proposed: 302, accepted: 0, dismissed: 0, exported: 0 },
    });
    if (loaded.status === 'ready') {
      expect(loaded.proposals).toHaveLength(302);
      expect(loaded.reviewBytes).toBeGreaterThan(0);
    }
  });

  it('fails closed above 5,000 rows and 8 MiB without loading proposal bodies', async () => {
    await database.sql`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      select ${orgA}::uuid, ${profileA}::uuid, 'over-row-limit',
             'large-campaign-' || source.ordinal, 'large-group-' || source.ordinal,
             'large query ' || source.ordinal, 'large query ' || source.ordinal,
             'excluded', 'profit', 'negative_exact', 'Synthetic capacity row.'
        from generate_series(1, 5001) as source(ordinal)
    `;
    const rows = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: 'over-row-limit',
    });
    expect(rows).toMatchObject({
      status: 'capacity_exceeded',
      reason: 'row_limit',
      rowCount: 5001,
      proposals: [],
    });

    await database.sql`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      values (
        ${orgA}::uuid, ${profileA}::uuid, 'over-byte-limit', 'byte-campaign',
        'byte-group', 'byte query', 'byte query', 'excluded', 'profit',
        'negative_exact', repeat('x', 8 * 1024 * 1024)
      )
    `;
    const bytes = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: 'over-byte-limit',
    });
    expect(bytes).toMatchObject({
      status: 'capacity_exceeded',
      reason: 'byte_limit',
      rowCount: 1,
      proposals: [],
    });
    expect(bytes.reviewBytes).toBeGreaterThan(8 * 1024 * 1024);
  }, 60_000);

  it('includes ordinary decision metadata in the 8 MiB complete-scope ceiling', async () => {
    const marketplaceId = 'decision-metadata-capacity';
    await database.sql`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason, status)
      select ${orgA}::uuid, ${profileA}::uuid, ${marketplaceId},
             'metadata-campaign-' || source.ordinal, 'metadata-group-' || source.ordinal,
             'Metadata query ' || source.ordinal, 'metadata query ' || source.ordinal,
             'excluded', 'profit', 'negative_exact', 'Synthetic metadata capacity row.',
             'accepted'
        from generate_series(1, 2100) as source(ordinal)
    `;
    await database.sql`
      insert into public.audit_log
        (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      select p.org_id, 'user', ${OWNER_A}, 'query_negative.accepted',
             'contextual_negative_proposal', p.id::text,
             jsonb_build_object('note', repeat('n', 4000)), 'test'
        from public.contextual_negative_proposals p
       where p.org_id = ${orgA}::uuid
         and p.profile_id = ${profileA}::uuid
         and p.marketplace_id = ${marketplaceId}
    `;

    const loaded = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
    });
    expect(loaded).toMatchObject({
      status: 'capacity_exceeded',
      reason: 'byte_limit',
      rowCount: 2100,
      proposals: [],
    });
    expect(loaded.reviewBytes).toBeGreaterThan(CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT);
  }, 60_000);

  it('rejects oversized selected commands before loading row bodies or writing evidence', async () => {
    const marketplaceId = 'oversized-selected-command';
    const input = {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
      campaignId: 'oversized-command-campaign',
      adGroupId: 'oversized-command-group',
      searchTerm: 'Oversized selected query',
      normalizedQuery: 'oversized selected query',
      category: 'excluded' as const,
      sourceGroupRole: 'profit' as const,
      matchType: 'negative_exact' as const,
      reason: 'x'.repeat(CONTEXTUAL_NEGATIVE_REVIEW_BYTE_LIMIT),
      status: 'accepted' as const,
    };
    const [inserted] = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason, status)
      values (
        ${input.orgId}::uuid, ${input.profileId}::uuid, ${input.marketplaceId},
        ${input.campaignId}, ${input.adGroupId}, ${input.searchTerm},
        ${input.normalizedQuery}, ${input.category}, ${input.sourceGroupRole},
        ${input.matchType}, ${input.reason}, ${input.status}
      )
      returning id
    `;
    if (inserted === undefined) throw new Error('missing oversized command fixture');
    const selection = [{
      id: inserted.id,
      expectedFingerprint: contextualNegativeReviewFingerprint({ ...input, id: inserted.id }),
    }];

    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
      proposals: selection,
      decision: 'dismissed',
      actorId: OWNER_A,
      note: 'Must fail before audit construction.',
    })).rejects.toThrow(/review fields exceed/i);
    await expect(exportAcceptedContextualNegatives(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
      proposals: selection,
      actorId: OWNER_A,
      note: 'Must fail before artifact construction.',
    })).rejects.toThrow(/review fields exceed/i);

    const [evidence] = await database.sql<{ audits: number; exports: number; status: string }[]>`
      select
        (select count(*)::int from public.audit_log
          where org_id = ${orgA}::uuid and target_id = ${inserted.id}) as audits,
        (select count(*)::int from public.contextual_negative_exports
          where org_id = ${orgA}::uuid and marketplace_id = ${marketplaceId}) as exports,
        (select status from public.contextual_negative_proposals where id = ${inserted.id}::uuid) as status
    `;
    expect(evidence).toEqual({ audits: 0, exports: 0, status: 'accepted' });
  }, 60_000);

  it('denies direct authenticated writes and hides foreign-tenant rows', async () => {
    await asUser(database, ANALYST_A, async (sql) => {
      await expect(sql`
        update public.contextual_negative_proposals
           set status = 'accepted'
         where id = ${proposalIds[0]!}::uuid
      `).rejects.toThrow(/permission denied/i);
      await expect(sql`
        insert into public.contextual_negative_exports
          (org_id, profile_id, marketplace_id, note, row_count,
           json_artifact, json_sha256, csv_artifact, csv_sha256, created_by)
        values (
          ${orgA}::uuid, ${profileA}::uuid, ${MARKETPLACE}, 'direct', 1,
          'x'::bytea, ${'a'.repeat(64)}, 'x'::bytea, ${'b'.repeat(64)}, ${ANALYST_A}
        )
      `).rejects.toThrow(/permission denied/i);
    });
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: [{ id: foreignProposalId, expectedFingerprint: '0'.repeat(64) }],
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewConflictError);

    const own = (await expectations([proposalIds[10]!]))[0]!;
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileB,
      marketplaceId: MARKETPLACE,
      proposals: [own],
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewConflictError);
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: 'another-marketplace',
      proposals: [own],
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewConflictError);
  });

  it('rejects one stale semantic field atomically without changing valid selected rows', async () => {
    const ids = proposalIds.slice(3, 5);
    const selected = await expectations(ids);
    await database.sql`
      update public.contextual_negative_proposals
         set reason = 'A newer classifier explanation.'
       where id = ${ids[0]!}::uuid
    `;
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: selected,
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewConflictError);
    const rows = await database.sql<{ id: string; status: string }[]>`
      select id, status from public.contextual_negative_proposals
       where id = any (${ids}::uuid[]) order by id
    `;
    expect(rows.every((row) => row.status === 'proposed')).toBe(true);
    const [audits] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
       where action = 'query_negative.accepted' and target_id = any (${ids}::text[])
    `;
    expect(audits?.count).toBe(0);
  });

  it('makes decisions all-or-nothing, audited before-state complete, and repeat-safe', async () => {
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations([proposalIds[2]!]),
      decision: 'dismissed',
      actorId: OWNER_A,
      note: '   ',
    })).rejects.toBeInstanceOf(ContextualNegativeReviewValidationError);
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: [
        ...(await expectations([proposalIds[0]!])),
        { id: foreignProposalId, expectedFingerprint: '0'.repeat(64) },
      ],
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewConflictError);

    const accepted = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations(proposalIds.slice(0, 2)),
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'Reviewed routing and exact-match scope.',
    });
    expect(accepted).toMatchObject({
      offered: 2,
      matched: 2,
      updated: 2,
      unchanged: 0,
      amazonUpdated: false,
    });
    const repeated = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations(proposalIds.slice(0, 2)),
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'No duplicate event.',
    });
    expect(repeated).toMatchObject({ updated: 0, unchanged: 2 });

    const audits = await database.sql<{ payload: Record<string, unknown> }[]>`
      select payload from public.audit_log
       where org_id = ${orgA}::uuid
         and action = 'query_negative.accepted'
         and target_id = any (${proposalIds.slice(0, 2)}::text[])
       order by target_id
    `;
    expect(audits).toHaveLength(2);
    expect(audits[0]?.payload).toMatchObject({
      targetStatus: 'accepted',
      note: 'Reviewed routing and exact-match scope.',
      before: {
        orgId: orgA,
        profileId: profileA,
        marketplaceId: MARKETPLACE,
        status: 'proposed',
        reviewFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });

  it('rejects duplicates and more than 500 actions before touching the database', async () => {
    const one = (await expectations([proposalIds[3]!]))[0]!;
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: [one, one],
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewValidationError);
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: Array.from({ length: CONTEXTUAL_NEGATIVE_ACTION_LIMIT + 1 }, (_, index) => ({
        id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
        expectedFingerprint: '0'.repeat(64),
      })),
      decision: 'accepted',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewValidationError);
  });

  it('preserves every reviewed content field across classifier refresh', async () => {
    const id = proposalIds[8]!;
    await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations([id]),
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'Reviewed before classifier refresh.',
    });
    const [before] = await database.sql<{
      marketplace_id: string;
      search_term: string;
      category: 'excluded';
      source_group_role: 'profit';
      reason: string;
      campaign_id: string;
      ad_group_id: string;
      normalized_query: string;
      match_type: 'negative_exact';
    }[]>`
      select marketplace_id, search_term, category, source_group_role, reason,
             campaign_id, ad_group_id, normalized_query, match_type
        from public.contextual_negative_proposals where id = ${id}::uuid
    `;
    if (before === undefined) throw new Error('missing preservation fixture');
    const result = await persistContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      proposals: [{
        profileId: profileA,
        marketplaceId: 'refreshed-marketplace',
        campaignId: before.campaign_id,
        adGroupId: before.ad_group_id,
        searchTerm: 'Refreshed search term',
        normalizedQuery: before.normalized_query,
        category: 'unreviewed',
        sourceGroupRole: 'rank',
        matchType: before.match_type,
        reason: 'Refreshed explanation that must not replace reviewed evidence.',
        status: 'proposed',
      }],
    });
    expect(result).toMatchObject({ preservedHumanDecisions: 1 });
    const [after] = await database.sql<typeof before extends infer T ? T[] : never>`
      select marketplace_id, search_term, category, source_group_role, reason,
             campaign_id, ad_group_id, normalized_query, match_type
        from public.contextual_negative_proposals where id = ${id}::uuid
    `;
    expect(after).toEqual(before);
  });

  it('serializes reversed overlapping decisions without deadlock and makes one stale', async () => {
    const ids = proposalIds.slice(5, 7);
    const selected = await expectations(ids);
    const outcomes = await Promise.allSettled([
      decideContextualNegativeProposals(database, {
        orgId: orgA,
        profileId: profileA,
        marketplaceId: MARKETPLACE,
        proposals: selected,
        decision: 'accepted',
        actorId: OWNER_A,
        note: 'Concurrent accept.',
      }),
      decideContextualNegativeProposals(database, {
        orgId: orgA,
        profileId: profileA,
        marketplaceId: MARKETPLACE,
        proposals: [...selected].reverse(),
        decision: 'dismissed',
        actorId: OWNER_A,
        note: 'Concurrent dismiss.',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ContextualNegativeReviewConflictError),
    });
    const rows = await database.sql<{ status: string }[]>`
      select status from public.contextual_negative_proposals
       where id = any (${ids}::uuid[])
    `;
    expect(new Set(rows.map((row) => row.status)).size).toBe(1);
  });

  it('uses the same advisory scope lock for refresh and decision', async () => {
    const id = proposalIds[11]!;
    const [stored] = await database.sql<{
      campaign_id: string;
      ad_group_id: string;
      normalized_query: string;
      match_type: 'negative_exact';
    }[]>`
      select campaign_id, ad_group_id, normalized_query, match_type
        from public.contextual_negative_proposals where id = ${id}::uuid
    `;
    if (stored === undefined) throw new Error('missing lock fixture');
    const selected = await expectations([id]);
    const lockKey = contextualNegativeReviewScopeLockKeys([{
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    }])[0]!;
    let release = () => {};
    let locked = () => {};
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      locked();
      await releaseGate;
    });
    await lockedGate;
    let decisionSettled = false;
    let refreshSettled = false;
    const decision = decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: selected,
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'Concurrent with refresh.',
    }).finally(() => { decisionSettled = true; });
    const refresh = persistContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      proposals: [{
        profileId: profileA,
        marketplaceId: MARKETPLACE,
        campaignId: stored.campaign_id,
        adGroupId: stored.ad_group_id,
        searchTerm: 'Refreshed while locked',
        normalizedQuery: stored.normalized_query,
        category: 'excluded',
        sourceGroupRole: 'profit',
        matchType: stored.match_type,
        reason: 'Refresh sharing the review scope lock.',
        status: 'proposed',
      }],
    }).finally(() => { refreshSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect({ decisionSettled, refreshSettled }).toEqual({
      decisionSettled: false,
      refreshSettled: false,
    });
    release();
    await holder;
    const outcomes = await Promise.allSettled([decision, refresh]);
    expect(outcomes[1]?.status).toBe('fulfilled');
    const [final] = await database.sql<{ status: string; search_term: string }[]>`
      select status, search_term from public.contextual_negative_proposals where id = ${id}::uuid
    `;
    if (outcomes[0]?.status === 'fulfilled') {
      expect(final).toMatchObject({ status: 'accepted', search_term: 'Synthetic query 12' });
    } else {
      expect(outcomes[0]?.reason).toBeInstanceOf(ContextualNegativeReviewConflictError);
      expect(final).toMatchObject({ status: 'proposed', search_term: 'Refreshed while locked' });
    }
  });

  it('returns explicit timeout capacity instead of a partial scope', async () => {
    let release = () => {};
    let locked = () => {};
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.sql.begin(async (sql) => {
      await sql`lock table public.contextual_negative_proposals in access exclusive mode`;
      locked();
      await releaseGate;
    });
    await lockedGate;
    const result = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    release();
    await holder;
    expect(result).toMatchObject({
      status: 'capacity_exceeded',
      reason: 'timeout',
      measurementsAvailable: false,
      proposals: [],
    });
    expect(result.rowCount).toBe(0);
  }, 10_000);

  it('fails a mutation closed when its five-second statement budget expires', async () => {
    const selected = await expectations([proposalIds[12]!]);
    let release = () => {};
    let locked = () => {};
    const releaseGate = new Promise<void>((resolve) => { release = resolve; });
    const lockedGate = new Promise<void>((resolve) => { locked = resolve; });
    const holder = database.sql.begin(async (sql) => {
      await sql`lock table public.contextual_negative_proposals in access exclusive mode`;
      locked();
      await releaseGate;
    });
    await lockedGate;
    try {
      await expect(decideContextualNegativeProposals(database, {
        orgId: orgA,
        profileId: profileA,
        marketplaceId: MARKETPLACE,
        proposals: selected,
        decision: 'accepted',
        actorId: OWNER_A,
        note: 'This command must time out closed.',
      })).rejects.toBeInstanceOf(ContextualNegativeReviewLockTimeoutError);
    } finally {
      release();
      await holder;
    }
  }, 10_000);

  it('rejects a mixed accepted/proposed export atomically without skipping rows', async () => {
    const marketplaceId = 'mixed-export-state';
    const inserted = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason, status)
      values
        (${orgA}::uuid, ${profileA}::uuid, ${marketplaceId}, 'mixed-campaign-a',
         'mixed-group-a', 'Mixed query accepted', 'mixed query accepted',
         'excluded', 'profit', 'negative_exact', 'Synthetic accepted row.', 'accepted'),
        (${orgA}::uuid, ${profileA}::uuid, ${marketplaceId}, 'mixed-campaign-b',
         'mixed-group-b', 'Mixed query proposed', 'mixed query proposed',
         'excluded', 'profit', 'negative_exact', 'Synthetic proposed row.', 'proposed')
      returning id
    `;
    const loaded = await loadContextualNegativeReview(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
    });
    if (loaded.status !== 'ready') throw new Error('mixed export fixture exceeded capacity');
    const proposals = loaded.proposals.map((row) => ({
      id: row.id,
      expectedFingerprint: row.reviewFingerprint,
    }));
    expect(proposals).toHaveLength(inserted.length);

    await expect(exportAcceptedContextualNegatives(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId,
      proposals,
      actorId: OWNER_A,
      note: 'Mixed status must fail as one command.',
    })).rejects.toBeInstanceOf(ContextualNegativeReviewStateError);

    const rows = await database.sql<{ status: string }[]>`
      select status from public.contextual_negative_proposals
       where id = any (${inserted.map((row) => row.id)}::uuid[])
       order by status
    `;
    const [evidence] = await database.sql<{ exports: number; audits: number }[]>`
      select
        (select count(*)::int from public.contextual_negative_exports
          where org_id = ${orgA}::uuid and marketplace_id = ${marketplaceId}) as exports,
        (select count(*)::int from public.audit_log
          where org_id = ${orgA}::uuid and action = 'query_negative.exported'
            and payload -> 'scope' ->> 'marketplaceId' = ${marketplaceId}) as audits
    `;
    expect(rows.map((row) => row.status)).toEqual(['accepted', 'proposed']);
    expect(evidence).toEqual({ exports: 0, audits: 0 });
  });

  it('stores one exact-byte JSON/CSV artifact, binds its audit, and makes export terminal', async () => {
    const result = await exportAcceptedContextualNegatives(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations(proposalIds.slice(0, 2)),
      actorId: OWNER_A,
      note: 'Offline evidence export. Amazon remains unchanged.',
    });
    expect(result).toMatchObject({
      offered: 2,
      matched: 2,
      accepted: 2,
      stamped: 2,
      storedJsonRows: 2,
      rowCount: 2,
      amazonUpdated: false,
    });
    const jsonArtifact = await getContextualNegativeExport(database, {
      orgId: orgA,
      exportId: result.exportId,
      format: 'json',
    });
    const csvArtifact = await getContextualNegativeExport(database, {
      orgId: orgA,
      exportId: result.exportId,
      format: 'csv',
    });
    expect(jsonArtifact?.sha256).toBe(result.jsonSha256);
    expect(csvArtifact?.sha256).toBe(result.csvSha256);
    expect(createHash('sha256').update(jsonArtifact?.bytes ?? '').digest('hex')).toBe(result.jsonSha256);
    expect(createHash('sha256').update(csvArtifact?.bytes ?? '').digest('hex')).toBe(result.csvSha256);
    expect(JSON.parse(jsonArtifact?.bytes.toString('utf8') ?? '{}')).toMatchObject({
      rowCount: 2,
      amazonUpdated: false,
      proposals: [{ status: 'accepted' }, { status: 'accepted' }],
    });
    expect(countContextualNegativeCsvRecords(csvArtifact?.bytes ?? Buffer.alloc(0))).toBe(3);
    expect(await getContextualNegativeExport(database, {
      orgId: orgB,
      exportId: result.exportId,
      format: 'json',
    })).toBeNull();

    const history = await listContextualNegativeExports(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(history.find((row) => row.id === result.exportId)).toMatchObject({
      rowCount: 2,
      jsonSha256: result.jsonSha256,
      csvSha256: result.csvSha256,
      createdBy: OWNER_A,
      amazonUpdated: false,
    });
    const [audit] = await database.sql<{ payload: Record<string, unknown> }[]>`
      select payload from public.audit_log
       where org_id = ${orgA}::uuid
         and action = 'query_negative.exported'
         and target_id = ${result.exportId}
    `;
    expect(audit?.payload).toMatchObject({
      exportId: result.exportId,
      rowCount: 2,
      jsonSha256: result.jsonSha256,
      csvSha256: result.csvSha256,
      proposalIds: result.exportedIds,
      amazonUpdated: false,
    });

    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposals: await expectations([proposalIds[0]!]),
      decision: 'proposed',
      actorId: OWNER_A,
    })).rejects.toBeInstanceOf(ContextualNegativeReviewStateError);
  });

  it('bounds export history to the newest fixed-size summary window', async () => {
    await database.sql`
      insert into public.contextual_negative_exports
        (org_id, profile_id, marketplace_id, note, row_count,
         json_artifact, json_sha256, csv_artifact, csv_sha256,
         created_by, created_at)
      select ${orgA}::uuid, ${profileA}::uuid, ${MARKETPLACE},
             'Synthetic history ' || source.ordinal, 1,
             convert_to('{"fixture":true}' || chr(10), 'UTF8'),
             ${'218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9'},
             convert_to('fixture' || chr(10), 'UTF8'),
             ${'e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f'},
             ${OWNER_A}, clock_timestamp() + source.ordinal * interval '1 second'
        from generate_series(1, ${CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT + 1})
          as source(ordinal)
    `;
    const history = await listContextualNegativeExports(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(history).toHaveLength(CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT);
    expect(history[0]?.note).toBe(
      `Synthetic history ${CONTEXTUAL_NEGATIVE_EXPORT_HISTORY_LIMIT + 1}`,
    );
    expect(history.at(-1)?.note).toBe('Synthetic history 2');
  });
});
