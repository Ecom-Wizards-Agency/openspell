/**
 * The Exports API and the campaign-name join.
 *
 * This is the half of the client the reference could never verify: v3 reporting
 * returns ids and no names, `_fetch_campaign_metadata` was left a stub, and
 * every campaign in the monitor is labelled with a number as a result. The
 * contract below is documentation-derived, so `scripts/smoke.ts` is what
 * actually confirms it — these tests confirm our half of it.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import { AdsApiParseError } from './errors.js';
import { adGroupNameIndex, buildExportBody, campaignNameIndex, isExportComplete, isExportFailed } from './exports.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';
import { EXPORT_CAMPAIGNS, PROFILE_ID } from './__fixtures__/payloads.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};

const EXPORT_ID = '11111111-2222-3333-4444-555555555555';
const DOWNLOAD_URL = 'https://offline-export-storage.s3.amazonaws.com/exports/fixture.json.gz';

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

describe('export requests', () => {
  it('filters by ad product and, when asked, by state', () => {
    expect(buildExportBody({ kind: 'campaigns', adProducts: ['SPONSORED_PRODUCTS'] })).toEqual({
      adProductFilter: ['SPONSORED_PRODUCTS'],
    });
    expect(
      buildExportBody({ kind: 'campaigns', adProducts: ['SPONSORED_PRODUCTS'], stateFilter: ['ENABLED'] }),
    ).toEqual({ adProductFilter: ['SPONSORED_PRODUCTS'], stateFilter: ['ENABLED'] });
  });

  it('posts the per-resource media type and returns the accepted export', async () => {
    const { server, client } = clientFor([
      {
        method: 'POST',
        match: '/campaigns/export',
        responses: [{ status: 202, json: { exportId: EXPORT_ID, status: 'PENDING' } }],
      },
    ]);

    const created = await client.createExport(PROFILE_ID, {
      kind: 'campaigns',
      adProducts: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'],
    });

    expect(created).toMatchObject({ exportId: EXPORT_ID, status: 'PENDING' });
    const request = server.requestsFor('/campaigns/export')[0];
    expect(request?.headers['content-type']).toBe('application/vnd.campaignsexport.v1+json');
    expect(request?.json).toEqual({ adProductFilter: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'] });
  });
});

describe('export polling', () => {
  it('reads the status envelope through to a download url', async () => {
    const { server, client } = clientFor([
      {
        method: 'GET',
        match: `/exports/${EXPORT_ID}`,
        responses: [
          { status: 200, json: { exportId: EXPORT_ID, status: 'PROCESSING' } },
          {
            status: 200,
            json: {
              exportId: EXPORT_ID,
              status: 'COMPLETED',
              url: DOWNLOAD_URL,
              fileSize: 2048,
              generatedAt: '2026-08-14T09:30:00Z',
            },
          },
        ],
      },
    ]);

    const processing = await client.getExport(PROFILE_ID, EXPORT_ID);
    const completed = await client.getExport(PROFILE_ID, EXPORT_ID);

    expect(isExportComplete(processing.status)).toBe(false);
    expect(isExportComplete(completed.status)).toBe(true);
    expect(completed.url).toBe(DOWNLOAD_URL);
    expect(server.requestsFor(`/exports/${EXPORT_ID}`)[0]?.headers['accept']).toBe(
      'application/vnd.export.v1+json',
    );
  });

  it('recognises a failed export', async () => {
    const { client } = clientFor([
      {
        method: 'GET',
        match: `/exports/${EXPORT_ID}`,
        responses: [{ status: 200, json: { exportId: EXPORT_ID, status: 'FAILED', error: 'TOO_LARGE' } }],
      },
    ]);

    const failed = await client.getExport(PROFILE_ID, EXPORT_ID);
    expect(isExportFailed(failed.status)).toBe(true);
    expect(failed.error).toBe('TOO_LARGE');
  });

  it('refuses a status envelope with no exportId', async () => {
    const { client } = clientFor([
      { method: 'GET', match: `/exports/${EXPORT_ID}`, responses: [{ status: 200, json: { status: 'PENDING' } }] },
    ]);

    await expect(client.getExport(PROFILE_ID, EXPORT_ID)).rejects.toBeInstanceOf(AdsApiParseError);
  });
});

describe('the campaign-name join', () => {
  it('downloads the export and indexes id to name', async () => {
    const gzipped = gzipSync(Buffer.from(JSON.stringify(EXPORT_CAMPAIGNS), 'utf8'));
    const { client } = clientFor([
      { method: 'GET', match: /s3\.amazonaws\.com/, responses: [{ status: 200, bytes: gzipped }] },
    ]);

    const download = await client.downloadExport(DOWNLOAD_URL);
    const names = campaignNameIndex(download.rows);

    expect(download.rows).toHaveLength(EXPORT_CAMPAIGNS.length);
    expect(download.payload.gzipped).toBe(true);
    // Four rows in, three usable: the fourth has no campaignId.
    expect(names.size).toBe(3);
    expect(names.get('100000000000001')).toBe('Placeholder SP Exact');
    expect(names.get('700000000000001')).toBe('Placeholder SB Video');
  });

  it('is what turns a report row into something a human can read', () => {
    const names = campaignNameIndex(EXPORT_CAMPAIGNS);
    const reportRow = { campaignId: '100000000000002', cost: 1.1 };
    // The reference falls back to the raw id here, and campaign classification
    // degrades to "Unknown" as a result.
    expect(names.get(reportRow.campaignId) ?? reportRow.campaignId).toBe('Placeholder SP Auto');
  });

  it('indexes ad group names the same way', () => {
    const index = adGroupNameIndex([
      { adGroupId: '200000000000001', name: 'Placeholder Ad Group' },
      { name: 'no id' },
    ]);
    expect(index.size).toBe(1);
    expect(index.get('200000000000001')).toBe('Placeholder Ad Group');
  });
});
