/** Authenticated browser proof that Grid rows moved out of the initial document. */
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { Response as PlaywrightResponse } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { readState } from './support/fixture';
import { signIn } from './support/auth';

const EXPECTED_ROWS = 3_597;
const MARKER = 'WP142 transport row';
const fixtureMonth = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15),
);
const DATE = fixtureMonth.toISOString().slice(0, 10);
const WARM_DATE = new Date(fixtureMonth.getTime() - 86_400_000).toISOString().slice(0, 10);

async function seedRows(): Promise<string> {
  const state = await readState();
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const [result] = await database.sql<{ count: number }[]>`
      with inserted as (
        insert into public.fact_search_term_daily
          (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
           search_term, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
           units_sold_7d)
        select ${state.orgId}, ${state.fixtureProfileId}, ${DATE}::date, 'SP', 'c-1', 'ag-1',
               null, ${MARKER} || ' ' || lpad(series::text, 4, '0'),
               case when series % 2 = 0
                 then 'exact'::public.match_type else 'phrase'::public.match_type end,
               100 + series, 5 + series % 10, (series % 100)::numeric / 10,
               series % 3, (series % 200)::numeric / 5, series % 4
          from generate_series(1, ${EXPECTED_ROWS}) as series
        returning 1
      )
      select count(*)::int as count from inserted
    `;
    const count = result?.count ?? 0;
    if (count !== EXPECTED_ROWS) {
      throw new Error(`Seeded ${EXPECTED_ROWS} Grid rows, wrote ${count}`);
    }
    return state.fixtureProfileId;
  } finally {
    await database.close();
  }
}

test('initial document stays small while one counted request powers the complete Grid and export', async ({
  page,
}, testInfo) => {
  const profile = await seedRows();
  await signIn(page, 'admin');

  // Compile the Grid page and route against an empty neighboring date. This
  // keeps the timing measurement about payload delivery rather than Next dev's
  // one-time module compilation.
  await page.goto(`/grid?profile=${profile}&entity=search_terms&from=${WARM_DATE}&to=${WARM_DATE}`);
  await expect(page.getByRole('button', { name: 'Export CSV (0 of 0)' })).toBeVisible();

  const rowResponses: PlaywrightResponse[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/grid/rows') rowResponses.push(response);
  });

  const startedAt = performance.now();
  const documentResponse = await page.goto(
    `/grid?profile=${profile}&entity=search_terms&from=${DATE}&to=${DATE}`,
    { waitUntil: 'domcontentloaded' },
  );
  expect(documentResponse).not.toBeNull();
  const initialDocument = await documentResponse!.body();
  await expect(
    page.getByRole('button', {
      name: `Export CSV (${EXPECTED_ROWS.toLocaleString('en-US')} of ${EXPECTED_ROWS.toLocaleString('en-US')})`,
    }),
  ).toBeVisible();
  const usableMs = performance.now() - startedAt;
  // A development Strict Mode replay happens immediately after mount. Waiting
  // one short task makes the request-count assertion catch a duplicate rather
  // than racing it.
  await page.waitForTimeout(100);

  expect(initialDocument.byteLength).toBeLessThanOrEqual(256 * 1_024);
  expect(initialDocument.toString('utf8')).not.toContain(MARKER);
  expect(rowResponses).toHaveLength(1);

  const gridResponse = rowResponses[0]!;
  expect(gridResponse.status()).toBe(200);
  expect(gridResponse.headers()['cache-control']).toContain('no-store');
  const responseBody = await gridResponse.body();
  const payload = JSON.parse(responseBody.toString('utf8')) as {
    rows: Array<{ dimensions: Record<string, unknown> }>;
    rowCount: number;
    truncated: boolean;
  };
  expect(payload.rowCount).toBe(EXPECTED_ROWS);
  expect(payload.rows).toHaveLength(EXPECTED_ROWS);
  expect(payload.truncated).toBe(false);
  expect(payload.rows.every((row) => String(row.dimensions['search_term']).startsWith(MARKER))).toBe(true);
  expect(gzipSync(responseBody).byteLength).toBeLessThan(4_000_000);

  const exportButton = page.getByRole('button', { name: /Export CSV/ });
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath!, 'utf8');
  const csvLines = csv.trimEnd().split('\n');
  expect(csvLines[0]).toContain(`${EXPECTED_ROWS} of ${EXPECTED_ROWS} source rows`);
  // One provenance line plus the CSV header precede the exact source rows.
  expect(csvLines).toHaveLength(EXPECTED_ROWS + 2);

  const measurements = {
    usableMs: Math.round(usableMs * 100) / 100,
    initialDocumentBytes: initialDocument.byteLength,
    rowResponseBytes: responseBody.byteLength,
    rowResponseGzipBytes: gzipSync(responseBody).byteLength,
    rows: payload.rowCount,
    requests: rowResponses.length,
  };
  console.info(JSON.stringify({ event: 'openspell.grid_boundary_e2e', ...measurements }));
  await testInfo.attach('grid-boundary-measurements.json', {
    body: Buffer.from(JSON.stringify(measurements, null, 2)),
    contentType: 'application/json',
  });

  expect(usableMs).toBeLessThan(2_000);
});
