import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  decideContextualNegativeProposals,
  exportAcceptedContextualNegatives,
  getContextualNegativeExport,
  listContextualNegativeExports,
  listContextualNegativeProposals,
} from './contextual-negative-review.js';

const available = await databaseAvailable();
const OWNER_A = '86868686-8686-4686-8686-868686868686';
const OWNER_B = '87878787-8787-4787-8787-878787878787';
const MARKETPLACE = 'review-marketplace';

describe.skipIf(!available)('contextual negative review and export', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';
  let proposalIds: string[] = [];
  let foreignProposalId = '';
  let exportId = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp86_query_review');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-a', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('query-review-b', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [aProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [bProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = aProfile?.id ?? '';
    profileB = bProfile?.id ?? '';

    const proposals = await database.sql<{ id: string; campaign_id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      select ${orgA}, ${profileA}, ${MARKETPLACE},
             'campaign-' || source.ordinal,
             'ad-group-' || source.ordinal,
             'Synthetic query ' || source.ordinal,
             'synthetic query ' || source.ordinal,
             'excluded', 'profit', 'negative_exact',
             'Synthetic exclusion reviewed at ad-group level.'
        from generate_series(1, 302) as source(ordinal)
      returning id, campaign_id
    `;
    proposalIds = proposals
      .sort((left, right) => left.campaign_id.localeCompare(right.campaign_id, undefined, { numeric: true }))
      .map((row) => row.id);

    const [foreign] = await database.sql<{ id: string }[]>`
      insert into public.contextual_negative_proposals
        (org_id, profile_id, marketplace_id, campaign_id, ad_group_id,
         search_term, normalized_query, category, source_group_role,
         match_type, reason)
      values (${orgB}, ${profileB}, ${MARKETPLACE}, 'foreign-campaign',
              'foreign-ad-group', 'Foreign synthetic query',
              'foreign synthetic query', 'excluded', 'profit',
              'negative_exact', 'Synthetic foreign proposal.')
      returning id
    `;
    foreignProposalId = foreign?.id ?? '';
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('reads the complete tenant marketplace queue with no 250-row undercount', async () => {
    const rows = await listContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(rows).toHaveLength(302);
    expect(rows.every((row) => row.status === 'proposed')).toBe(true);
  });

  it('requires a dismissal note and records exact, tenant-scoped decisions', async () => {
    await expect(decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [proposalIds[2] ?? ''],
      decision: 'dismissed',
      actorId: OWNER_A,
      note: '   ',
    })).rejects.toThrow(/dismissal needs a note/i);

    const accepted = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [proposalIds[0] ?? '', proposalIds[1] ?? ''],
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'Reviewed routing and exact-match scope.',
    });
    expect(accepted).toEqual({
      offered: 2,
      matched: 2,
      updated: 2,
      unchanged: 0,
      refused: [],
    });

    const repeated = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [proposalIds[0] ?? '', proposalIds[1] ?? ''],
      decision: 'accepted',
      actorId: OWNER_A,
      note: 'Repeated click should not create another decision.',
    });
    expect(repeated).toMatchObject({ updated: 0, unchanged: 2 });

    const dismissed = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [proposalIds[2] ?? ''],
      decision: 'dismissed',
      actorId: OWNER_A,
      note: 'Keep this query in its current route.',
    });
    expect(dismissed).toMatchObject({ offered: 1, matched: 1, updated: 1 });

    const foreign = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [foreignProposalId],
      decision: 'accepted',
      actorId: OWNER_A,
    });
    expect(foreign).toEqual({
      offered: 1,
      matched: 0,
      updated: 0,
      unchanged: 0,
      refused: [],
    });

    const audits = await database.sql<{ action: string; note: string }[]>`
      select action, payload ->> 'note' as note
        from public.audit_log
       where org_id = ${orgA}
         and target_type = 'contextual_negative_proposal'
         and target_id = any (${proposalIds.slice(0, 3)}::text[])
       order by id
    `;
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.action)).toEqual([
      'query_negative.accepted',
      'query_negative.accepted',
      'query_negative.dismissed',
    ]);
    expect(audits.at(-1)?.note).toBe('Keep this query in its current route.');
  });

  it('exports only accepted rows into one immutable, counted snapshot', async () => {
    const result = await exportAcceptedContextualNegatives(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: proposalIds.slice(0, 3),
      actorId: OWNER_A,
      note: 'Offline review export. Amazon remains unchanged.',
    });
    exportId = result.exportId;
    expect(result).toMatchObject({
      offered: 3,
      matched: 3,
      accepted: 2,
      exported: 2,
      skipped: [{ id: proposalIds[2], status: 'dismissed' }],
    });
    expect(result.artifactSha256).toMatch(/^[0-9a-f]{64}$/);

    const artifact = await getContextualNegativeExport(database, {
      orgId: orgA,
      exportId,
    });
    expect(artifact).not.toBeNull();
    expect(artifact?.rowCount).toBe(2);
    expect(artifact?.items).toHaveLength(2);
    expect(artifact?.items.map((item) => item.proposalId)).toEqual(proposalIds.slice(0, 2));
    expect(artifact?.items.every((item) => item.reason.includes('ad-group level'))).toBe(true);
    expect(artifact?.items.every((item) => item.decisionNote === 'Reviewed routing and exact-match scope.')).toBe(true);

    const history = await listContextualNegativeExports(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: exportId, rowCount: 2 });

    const proposals = await listContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
    });
    expect(proposals.filter((row) => row.status === 'exported')).toHaveLength(2);
    expect(proposals.find((row) => row.id === proposalIds[2])?.status).toBe('dismissed');

    const [exportAudit] = await database.sql<{ rows: number }[]>`
      select (payload ->> 'rows')::int as rows
        from public.audit_log
       where org_id = ${orgA} and action = 'query_negative.exported'
         and target_id = ${exportId}
    `;
    expect(exportAudit?.rows).toBe(2);
  });

  it('keeps exported evidence terminal and refuses in-place mutation', async () => {
    const decision = await decideContextualNegativeProposals(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: [proposalIds[0] ?? ''],
      decision: 'proposed',
      actorId: OWNER_A,
    });
    expect(decision).toMatchObject({ updated: 0, refused: [{ id: proposalIds[0], status: 'exported' }] });

    await database.sql`
      update public.contextual_negative_proposals
         set reason = 'Later live-proposal explanation.'
       where id = ${proposalIds[0] ?? ''}
    `;
    const frozenArtifact = await getContextualNegativeExport(database, {
      orgId: orgA,
      exportId,
    });
    expect(frozenArtifact?.items[0]?.reason).toBe('Synthetic exclusion reviewed at ad-group level.');

    await expect(database.sql`
      update public.contextual_negative_exports set note = 'changed' where id = ${exportId}
    `).rejects.toThrow(/immutable/i);
    await expect(database.sql`
      update public.contextual_negative_export_items
         set reason = 'changed'
       where export_id = ${exportId} and ordinal = 1
    `).rejects.toThrow(/immutable/i);
    await expect(exportAcceptedContextualNegatives(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: MARKETPLACE,
      proposalIds: proposalIds.slice(0, 2),
      actorId: OWNER_A,
      note: 'No accepted rows remain in this selected set.',
    })).rejects.toThrow(/no accepted proposals/i);
  });
});
