import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState, type E2EState } from './support/fixture';

test.describe.configure({ mode: 'serial' });

const FILTERED_CAMPAIGN_COUNT = 56;
const FILTERED_CAMPAIGN_PREFIX = 'WP195 Filtered Campaign';
const FILTERED_CAMPAIGN_ID_PREFIX = 'wp195-filtered-campaign';

interface AssignmentEvidence {
  campaign_id: string;
  group_id: string;
}

interface ApplyEvidence {
  apply_batches: number;
  apply_rows: number;
  apply_changes: number;
}

test('edits a canonical local weekday schedule and still queues a manual preview', async ({ page }) => {
  await signIn(page, 'admin');
  const state = await readState();
  const { fixtureProfileId } = state;
  await page.goto(`/optimizer/groups?profile=${fixtureProfileId}`);

  await expect(page.getByRole('heading', { name: 'Optimization Groups', exact: true })).toBeVisible();
  await expect(page.getByText('UTC · 04:00 local')).toBeVisible();

  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayChecks = weekdayNames.map((name) => page.getByRole('checkbox', { name, exact: true }));
  for (const checkbox of weekdayChecks) await expect(checkbox).toBeChecked();

  for (const checkbox of weekdayChecks.slice(1)) await checkbox.uncheck();
  await weekdayChecks[0]?.click();
  await expect(weekdayChecks[0]!).toBeChecked();

  await page.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Saved 1 campaign assignment');
  await expect(page.getByText(/Target ACOS .* · Mon$/)).toBeVisible();

  // Weekday eligibility belongs only to the default-off scheduler. An
  // operator's manual preview remains available and still creates no Amazon write.
  try {
    await page.getByRole('button', { name: 'Run group preview', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Preview queued');
    await expect(page.getByRole('status')).toContainText('Amazon is unchanged');
  } finally {
    // This is one serial suite. The manual-preview assertion above intentionally
    // creates an active group run; close its fixture rows so the campaign-scope
    // test cannot pass or fail according to order-dependent queue residue.
    await settleActiveRecommendationRuns(state);
  }
});

test('selects filtered campaigns across pages and polls the exact read-only preview scope', async ({
  page,
}) => {
  const state = await readState();
  const selectedCampaignIds = [1, 26, 51].map(filteredCampaignId);
  await seedFilteredCampaigns(state);

  const before = await readDatabaseEvidence(state);

  await signIn(page, 'admin');
  await page.goto(`/optimizer?profile=${state.fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Campaign Optimizer', exact: true })).toBeVisible();

  const search = page.getByRole('search', { name: 'Filter optimizer campaigns' });
  await search.getByLabel('Find campaign').fill(FILTERED_CAMPAIGN_PREFIX);
  await expect(page.getByText(`1–25 of ${FILTERED_CAMPAIGN_COUNT}`, { exact: true })).toBeVisible();

  const selectFiltered = page.getByTestId('optimizer-select-filtered');
  await expect(selectFiltered).toHaveAccessibleName(
    `Select all ${FILTERED_CAMPAIGN_COUNT} eligible campaigns matching current filters`,
  );
  await selectFiltered.check();
  await expect(page.getByTestId('optimizer-selection-count')).toContainText(
    `${FILTERED_CAMPAIGN_COUNT} campaigns selected`,
  );

  // The header owns the complete filtered result, not only the first 25 rows.
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  const pageTwoCampaign = page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(26)} for this preview`,
  });
  await expect(pageTwoCampaign).toBeChecked();
  await pageTwoCampaign.uncheck();
  await expect(page.getByTestId('optimizer-selection-count')).toContainText('55 campaigns selected');

  // Narrowing the view preserves every hidden selection. Clear selected must
  // then clear that entire transient set, including rows on hidden pages.
  await search.getByLabel('Find campaign').fill(filteredCampaignName(1));
  await expect(page.getByTestId('optimizer-selection-count')).toContainText('55 campaigns selected');
  await expect(page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(1)} for this preview`,
  })).toBeChecked();
  await page.getByRole('button', { name: 'Clear selected', exact: true }).click();
  await expect(page.getByTestId('optimizer-selection-count')).toHaveText('No campaigns selected.');

  // Build an explicit subset from three different pages after the global clear.
  await search.getByLabel('Find campaign').fill(FILTERED_CAMPAIGN_PREFIX);
  await page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(1)} for this preview`,
  }).check();
  await expect(selectFiltered).toHaveJSProperty('indeterminate', true);
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(26)} for this preview`,
  }).check();
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByRole('checkbox', {
    name: `Select ${filteredCampaignName(51)} for this preview`,
  }).check();

  await expect(page.getByRole('radio', { name: 'Selected campaigns (3)', exact: true }))
    .toBeChecked();
  const run = page.getByTestId('optimizer-run-preview');
  await expect(run).toHaveText('Run preview · 3 selected');

  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && url.pathname === '/api/optimizer/runs';
  });
  await run.click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const accepted = await response.json() as {
    batchId: string;
    childCount: number;
    scope: { campaignCount: number; fingerprint: string; mode: string };
  };
  expect(accepted.scope).toMatchObject({ mode: 'selected', campaignCount: 3 });
  expect(accepted.childCount).toBe(2);
  await expect(page.getByText(/Preview queued for 3 campaigns across 2 runs\./)).toBeVisible();

  const stored = await readStoredScope(state, accepted.batchId);
  expect(stored.batch).toEqual({
    selection_mode: 'selected',
    scope_count: 3,
    scope_fingerprint: accepted.scope.fingerprint,
    child_count: 2,
  });
  expect(stored.campaignIds).toEqual(selectedCampaignIds);
  expect(stored.childCounts).toEqual([1, 2]);

  const afterEnqueue = await readDatabaseEvidence(state);
  expect(afterEnqueue.assignments).toEqual(before.assignments);
  expect(afterEnqueue.applyEvidence).toEqual(before.applyEvidence);

  // Emulate worker completion in the queue/run ledgers. The browser must
  // discover this through its bounded polling loop without a manual reload.
  await succeedPreviewBatch(state, accepted.batchId, accepted.childCount);
  await expect(page.getByText('Preview completed. No changes were recommended.', { exact: true }))
    .toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('list', { name: 'Preview runs' })
    .getByRole('link', { name: 'Review 0 recommendations →' }))
    .toHaveCount(accepted.childCount);

  const afterCompletion = await readDatabaseEvidence(state);
  expect(afterCompletion.assignments).toEqual(before.assignments);
  expect(afterCompletion.applyEvidence).toEqual(before.applyEvidence);
});

function filteredCampaignId(index: number): string {
  return `${FILTERED_CAMPAIGN_ID_PREFIX}-${String(index).padStart(2, '0')}`;
}

function filteredCampaignName(index: number): string {
  return `${FILTERED_CAMPAIGN_PREFIX} ${String(index).padStart(2, '0')}`;
}

async function withDatabase<T>(state: E2EState, action: (database: ReturnType<typeof createDb>) => Promise<T>): Promise<T> {
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    return await action(database);
  } finally {
    await database.close();
  }
}

async function settleActiveRecommendationRuns(state: E2EState): Promise<void> {
  await withDatabase(state, async (database) => {
    const active = await database.sql<{ id: string }[]>`
      select id
        from public.recommendation_runs
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and status in ('queued', 'running')
       order by id
    `;
    const runIds = active.map((row) => row.id);
    if (runIds.length === 0) return;
    const jobs = await database.sql<{ id: string }[]>`
      update public.sync_jobs
         set status = 'succeeded', finished_at = now(), result = '{}'::jsonb
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and payload ->> 'runId' = any (${runIds}::text[])
         and status in ('queued', 'running')
      returning id
    `;
    const runs = await database.sql<{ id: string }[]>`
      update public.recommendation_runs
         set status = 'succeeded', finished_at = now(), proposals_count = 0, error = null
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and id = any (${runIds}::uuid[])
         and status in ('queued', 'running')
      returning id
    `;
    expect(jobs).toHaveLength(runIds.length);
    expect(runs).toHaveLength(runIds.length);
  });
}

async function seedFilteredCampaigns(state: E2EState): Promise<void> {
  await withDatabase(state, async (database) => {
    const campaigns = Array.from({ length: FILTERED_CAMPAIGN_COUNT }, (_, offset) => ({
      amazon_id: filteredCampaignId(offset + 1),
      name: filteredCampaignName(offset + 1),
    }));
    const inserted = await database.sql<{ amazon_id: string }[]>`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      select ${state.orgId}, ${state.fixtureProfileId}, offered.amazon_id,
             'SP'::public.ad_product, offered.name, 'enabled'::public.entity_state,
             10.00, 'daily'::public.budget_type
        from jsonb_to_recordset(${JSON.stringify(campaigns)}::jsonb) as offered(
          amazon_id text,
          name text
        )
      returning amazon_id
    `;
    expect(inserted).toHaveLength(FILTERED_CAMPAIGN_COUNT);

    const assigned = await database.sql<{ campaign_id: string }[]>`
      insert into public.campaign_optimization_assignments
        (org_id, profile_id, campaign_id, group_id)
      select ${state.orgId}, ${state.fixtureProfileId}, campaign.amazon_id, optimization_group.id
        from public.campaigns campaign
        cross join lateral (
          select id
            from public.optimization_groups
           where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
           order by id
           limit 1
        ) optimization_group
       where campaign.org_id = ${state.orgId}
         and campaign.profile_id = ${state.fixtureProfileId}
         and campaign.amazon_id = any (${campaigns.slice(0, 28).map((row) => row.amazon_id)}::text[])
      returning campaign_id
    `;
    expect(assigned).toHaveLength(28);
  });
}

async function readDatabaseEvidence(state: E2EState): Promise<{
  assignments: AssignmentEvidence[];
  applyEvidence: ApplyEvidence;
}> {
  return withDatabase(state, async (database) => {
    const assignments = await database.sql<AssignmentEvidence[]>`
      select campaign_id, group_id::text as group_id
        from public.campaign_optimization_assignments
       where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
       order by campaign_id collate "C", group_id
    `;
    const rows = await database.sql<ApplyEvidence[]>`
      select
        (select count(*)::int from public.apply_batches
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}) as apply_batches,
        (select count(*)::int from public.apply_rows
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}) as apply_rows,
        (select count(*)::int from public.entity_changes
          where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}
            and source = 'apply') as apply_changes
    `;
    const applyEvidence = rows[0];
    if (applyEvidence === undefined) throw new Error('Could not read apply evidence');
    return { assignments, applyEvidence };
  });
}

async function readStoredScope(state: E2EState, batchId: string): Promise<{
  batch: {
    selection_mode: string;
    scope_count: number;
    scope_fingerprint: string;
    child_count: number;
  };
  campaignIds: string[];
  childCounts: number[];
}> {
  return withDatabase(state, async (database) => {
    const batches = await database.sql<{
      selection_mode: string;
      scope_count: number;
      scope_fingerprint: string;
      child_count: number;
    }[]>`
      select selection_mode, scope_count, scope_fingerprint, child_count
        from public.recommendation_preview_batches
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and id = ${batchId}
    `;
    const batch = batches[0];
    if (batch === undefined) throw new Error('Preview batch was not stored');

    const members = await database.sql<{ campaign_id: string }[]>`
      select campaign_id
        from public.recommendation_run_campaigns
       where org_id = ${state.orgId}
         and profile_id = ${state.fixtureProfileId}
         and batch_id = ${batchId}
       order by campaign_id collate "C"
    `;
    const children = await database.sql<{ scope_count: number; persisted_count: number }[]>`
      select run.scope_count, count(member.campaign_id)::int as persisted_count
        from public.recommendation_runs run
        join public.sync_jobs job
          on job.org_id = run.org_id
         and job.profile_id = run.profile_id
         and job.id = run.job_id
        left join public.recommendation_run_campaigns member
          on member.org_id = run.org_id
         and member.profile_id = run.profile_id
         and member.run_id = run.id
       where run.org_id = ${state.orgId}
         and run.profile_id = ${state.fixtureProfileId}
         and run.batch_id = ${batchId}
         and job.payload ->> 'runId' = run.id::text
       group by run.id, run.scope_count
       order by run.scope_count
    `;
    expect(children).toHaveLength(batch.child_count);
    for (const child of children) expect(child.persisted_count).toBe(child.scope_count);
    return {
      batch,
      campaignIds: members.map((row) => row.campaign_id),
      childCounts: children.map((row) => row.scope_count),
    };
  });
}

async function succeedPreviewBatch(
  state: E2EState,
  batchId: string,
  expectedChildren: number,
): Promise<void> {
  await withDatabase(state, async (database) => {
    await database.sql.begin(async (sql) => {
      const jobs = await sql<{ id: string }[]>`
        update public.sync_jobs job
           set status = 'succeeded', finished_at = now(), result = '{}'::jsonb
          from public.recommendation_runs run
         where run.org_id = ${state.orgId}
           and run.profile_id = ${state.fixtureProfileId}
           and run.batch_id = ${batchId}
           and run.job_id = job.id
           and job.org_id = run.org_id
           and job.profile_id = run.profile_id
           and job.status in ('queued', 'running')
        returning job.id
      `;
      const runs = await sql<{ id: string }[]>`
        update public.recommendation_runs
           set status = 'succeeded', finished_at = now(), proposals_count = 0, error = null
         where org_id = ${state.orgId}
           and profile_id = ${state.fixtureProfileId}
           and batch_id = ${batchId}
           and status in ('queued', 'running')
        returning id
      `;
      expect(jobs).toHaveLength(expectedChildren);
      expect(runs).toHaveLength(expectedChildren);
    });
  });
}
