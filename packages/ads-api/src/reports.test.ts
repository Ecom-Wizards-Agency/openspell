/**
 * Reporting v3, end to end: request, poll, download, parse.
 *
 * The flow is asynchronous and slow (Amazon documents up to three hours), so
 * the client exposes three separate calls and the *test* plays the part of the
 * worker's poll loop. That is the point of the split: nothing here blocks, and
 * a killed worker resumes from a report id rather than losing the report.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import { AdsApiParseError, DuplicateReportError } from './errors.js';
import { parseSpTargetingReport } from './parsers.js';
import {
  REPORT_SPECS,
  buildReportRequestBody,
  defaultReportName,
  isReportComplete,
  isTerminalFailure,
} from './reports.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import { PROFILE_ID, REPORT_SP_TARGETING } from './__fixtures__/payloads.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

const REPORT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DOWNLOAD_URL = 'https://offline-report-storage.s3.amazonaws.com/reports/fixture.json.gz';

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: async () => undefined,
    }),
  };
}

describe('report request bodies', () => {
  it('asks for GZIP_JSON daily rows for every report type in the contract', () => {
    for (const reportType of Object.keys(REPORT_SPECS) as (keyof typeof REPORT_SPECS)[]) {
      const body = buildReportRequestBody({ reportType, startDate: '2026-08-01', endDate: '2026-08-10' });
      const configuration = body['configuration'] as Record<string, unknown>;
      expect(configuration['format']).toBe('GZIP_JSON');
      expect(configuration['timeUnit']).toBe('DAILY');
      expect(configuration['columns']).toContain('date');
      expect((configuration['groupBy'] as string[]).length).toBeGreaterThan(0);
    }
  });

  it('groups placement rows on the spCampaigns report type, because there is no spPlacement', () => {
    const body = buildReportRequestBody({ reportType: 'spPlacement', startDate: '2026-08-01', endDate: '2026-08-10' });
    const configuration = body['configuration'] as Record<string, unknown>;
    expect(configuration['reportTypeId']).toBe('spCampaigns');
    expect(configuration['groupBy']).toEqual(['campaign', 'campaignPlacement']);
    // Impression share is not available once placement is in the grouping.
    expect(configuration['columns']).not.toContain('topOfSearchImpressionShare');
  });

  it('routes each ad product to its own report type', () => {
    expect(REPORT_SPECS.sbCampaigns.adProduct).toBe('SPONSORED_BRANDS');
    expect(REPORT_SPECS.sdCampaigns.adProduct).toBe('SPONSORED_DISPLAY');
    expect(REPORT_SPECS.spTargeting.groupBy).toEqual(['targeting']);
    expect(REPORT_SPECS.spSearchTerm.groupBy).toEqual(['searchTerm']);
  });

  it('names a report deterministically, so a re-request is recognisably identical', () => {
    const input = { reportType: 'spTargeting', startDate: '2026-08-01', endDate: '2026-08-10' } as const;
    expect(defaultReportName(input)).toBe('wizard-ads spTargeting 2026-08-01..2026-08-10');
    expect(buildReportRequestBody(input)['name']).toBe(defaultReportName(input));
  });

  it('lets a caller override the column list without a code change', () => {
    const body = buildReportRequestBody({
      reportType: 'sbCampaigns',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      columns: ['date', 'campaignId', 'impressions'],
    });
    expect((body['configuration'] as Record<string, unknown>)['columns']).toEqual([
      'date',
      'campaignId',
      'impressions',
    ]);
  });
});

describe('createReport', () => {
  it('posts the versioned media type and returns the accepted report', async () => {
    const { server, client } = clientFor([
      {
        method: 'POST',
        match: '/reporting/reports',
        responses: [{ status: 202, json: { reportId: REPORT_ID, status: 'PENDING', url: null } }],
      },
    ]);

    const report = await client.createReport(PROFILE_ID, {
      reportType: 'spTargeting',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
    });

    expect(report).toMatchObject({ reportId: REPORT_ID, status: 'PENDING', url: null });
    const request = server.requestsFor('/reporting/reports')[0];
    expect(request?.headers['content-type']).toBe('application/vnd.createasyncreportrequest.v3+json');
    expect(request?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    expect((request?.json as { startDate?: string } | null)?.startDate).toBe('2026-08-01');
  });

  it('turns a 425 into the id of the report already in flight', async () => {
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/reporting/reports',
        responses: [
          {
            status: 425,
            json: { detail: `Duplicate report request. Existing report id ${REPORT_ID}` },
          },
        ],
      },
    ]);

    const error = await client
      .createReport(PROFILE_ID, { reportType: 'spTargeting', startDate: '2026-08-01', endDate: '2026-08-10' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DuplicateReportError);
    // Adopting the existing report is the whole point of recognising a 425.
    expect((error as DuplicateReportError).existingReportId).toBe(REPORT_ID);
  });

  it('reads a reportId property on a 425 when Amazon supplies one', async () => {
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/reporting/reports',
        responses: [{ status: 425, json: { reportId: REPORT_ID, status: 'PENDING' } }],
      },
    ]);

    const error = await client
      .createReport(PROFILE_ID, { reportType: 'spTargeting', startDate: '2026-08-01', endDate: '2026-08-10' })
      .catch((cause: unknown) => cause);

    expect((error as DuplicateReportError).existingReportId).toBe(REPORT_ID);
  });

  it('never re-sends a create blindly: a duplicate report costs quota', async () => {
    const { server, client } = clientFor([
      { method: 'POST', match: '/reporting/reports', responses: [{ status: 503, json: {} }] },
    ]);

    await expect(
      client.createReport(PROFILE_ID, { reportType: 'spTargeting', startDate: '2026-08-01', endDate: '2026-08-10' }),
    ).rejects.toThrow();
    expect(server.requestsFor('/reporting/reports')).toHaveLength(1);
  });
});

describe('getReport', () => {
  it('walks PENDING to PROCESSING to COMPLETED without the client ever waiting', async () => {
    const { server, client } = clientFor([
      {
        method: 'GET',
        match: `/reporting/reports/${REPORT_ID}`,
        responses: [
          { status: 200, json: { reportId: REPORT_ID, status: 'PENDING', url: null } },
          { status: 200, json: { reportId: REPORT_ID, status: 'PROCESSING', url: null } },
          {
            status: 200,
            json: {
              reportId: REPORT_ID,
              status: 'COMPLETED',
              url: DOWNLOAD_URL,
              urlExpiresAt: '2026-08-14T12:00:00Z',
              fileSize: 4096,
            },
          },
        ],
      },
    ]);

    const statuses: string[] = [];
    let latest = await client.getReport(PROFILE_ID, REPORT_ID);
    statuses.push(latest.status);
    while (!isReportComplete(latest.status) && !isTerminalFailure(latest.status)) {
      latest = await client.getReport(PROFILE_ID, REPORT_ID);
      statuses.push(latest.status);
    }

    expect(statuses).toEqual(['PENDING', 'PROCESSING', 'COMPLETED']);
    expect(latest.url).toBe(DOWNLOAD_URL);
    expect(latest.fileSize).toBe(4096);
    expect(server.requestsFor(`/reporting/reports/${REPORT_ID}`)).toHaveLength(3);
  });

  it('surfaces FAILURE with its reason instead of retrying it forever', async () => {
    const { client } = clientFor([
      {
        method: 'GET',
        match: `/reporting/reports/${REPORT_ID}`,
        responses: [
          { status: 200, json: { reportId: REPORT_ID, status: 'FAILURE', failureReason: 'INTERNAL_ERROR' } },
        ],
      },
    ]);

    const report = await client.getReport(PROFILE_ID, REPORT_ID);

    expect(isTerminalFailure(report.status)).toBe(true);
    expect(report.failureReason).toBe('INTERNAL_ERROR');
  });

  it('refuses a status response with no reportId', async () => {
    const { client } = clientFor([
      { method: 'GET', match: `/reporting/reports/${REPORT_ID}`, responses: [{ status: 200, json: { status: 'PENDING' } }] },
    ]);

    await expect(client.getReport(PROFILE_ID, REPORT_ID)).rejects.toBeInstanceOf(AdsApiParseError);
  });
});

describe('downloadReport', () => {
  const gzipped = gzipSync(Buffer.from(JSON.stringify(REPORT_SP_TARGETING), 'utf8'));

  it('gunzips the payload and reports both byte counts', async () => {
    const { server, client } = clientFor([
      { method: 'GET', match: /s3\.amazonaws\.com/, responses: [{ status: 200, bytes: gzipped }] },
    ]);

    const download = await client.downloadReport(DOWNLOAD_URL);

    expect(download.rows).toHaveLength(REPORT_SP_TARGETING.length);
    expect(download.payload.gzipped).toBe(true);
    expect(download.payload.downloadedBytes).toBe(gzipped.byteLength);
    expect(download.payload.decodedBytes).toBeGreaterThan(download.payload.downloadedBytes);

    // The pre-signed URL carries its own signature; an Authorization header on
    // top of it is at best ignored and at worst a 400.
    const request = server.requestsFor(/s3\.amazonaws\.com/)[0];
    expect(request?.headers['authorization']).toBeUndefined();
  });

  it('tolerates a body the transport already decompressed', async () => {
    const { client } = clientFor([
      {
        method: 'GET',
        match: /s3\.amazonaws\.com/,
        responses: [{ status: 200, text: JSON.stringify(REPORT_SP_TARGETING) }],
      },
    ]);

    const download = await client.downloadReport(DOWNLOAD_URL);

    expect(download.payload.gzipped).toBe(false);
    expect(download.rows).toHaveLength(REPORT_SP_TARGETING.length);
    expect(download.payload.decodedBytes).toBe(download.payload.downloadedBytes);
  });

  it('fails on a corrupt gzip rather than returning an empty report', async () => {
    const corrupt = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const { client } = clientFor([
      { method: 'GET', match: /s3\.amazonaws\.com/, responses: [{ status: 200, bytes: corrupt }] },
    ]);

    await expect(client.downloadReport(DOWNLOAD_URL)).rejects.toBeInstanceOf(AdsApiParseError);
  });

  it('fails on a JSON object where an array of rows was promised', async () => {
    const { client } = clientFor([
      { method: 'GET', match: /s3\.amazonaws\.com/, responses: [{ status: 200, text: '{"rows": []}' }] },
    ]);

    await expect(client.downloadReport(DOWNLOAD_URL)).rejects.toThrow(/expected a JSON array/);
  });
});

describe('request to parsed rows', () => {
  it('accounts for every downloaded row (Rule 4)', async () => {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(REPORT_SP_TARGETING), 'utf8'));
    const { client } = clientFor([
      {
        method: 'POST',
        match: '/reporting/reports',
        responses: [{ status: 202, json: { reportId: REPORT_ID, status: 'PENDING' } }],
      },
      {
        method: 'GET',
        match: `/reporting/reports/${REPORT_ID}`,
        responses: [{ status: 200, json: { reportId: REPORT_ID, status: 'COMPLETED', url: DOWNLOAD_URL } }],
      },
      { method: 'GET', match: /s3\.amazonaws\.com/, responses: [{ status: 200, bytes: gzipped }] },
    ]);

    const requested = await client.createReport(PROFILE_ID, {
      reportType: 'spTargeting',
      startDate: '2026-08-10',
      endDate: '2026-08-10',
    });
    const polled = await client.getReport(PROFILE_ID, requested.reportId);
    const download = await client.downloadReport(polled.url ?? '');
    const parsed = parseSpTargetingReport(download.rows);

    expect(parsed.input).toBe(download.rows.length);
    expect(parsed.rows.length + parsed.skipped.length).toBe(parsed.input);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.skipped).toEqual([{ index: 3, reason: 'no daily date column' }]);
  });
});
