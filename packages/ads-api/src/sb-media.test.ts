/** Recorded fixtures for SB v4 media upload/describe and creative create/update/list. */
import { describe, expect, it } from 'vitest';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { AdsApiClient } from './client.js';
import { AdsApiParseError, DuplicateWriteError } from './errors.js';
import {
  SB_CREATIVE_LIST_PATH,
  SB_CREATIVE_MEDIA_TYPE,
  SB_CREATIVE_PATH,
  SB_MEDIA_DESCRIBE_PATH,
  SB_MEDIA_MULTIPART_BOUNDARY,
  SB_MEDIA_UPLOAD_PATH,
  type SbCreative,
} from './sb-media.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};
const ID_1 = '100000000000001';
const ID_2 = '100000000000002';

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const effects = testEffects();
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    effects,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: effects.sleep,
      now: effects.now,
      random: effects.random,
    }),
  };
}

function creative(creativeId = ID_1, state = 'ENABLED'): Omit<SbCreative, 'raw'> {
  return {
    creativeId,
    adGroupId: ID_1,
    creativeType: 'VIDEO',
    state,
    assets: [{ assetId: ID_2, role: 'VIDEO' }],
    name: 'Synthetic creative',
    headline: 'Synthetic headline',
    landingPageUrl: null,
    asins: ['B000000001'],
  };
}

describe('SB v4 media', () => {
  it('uploads multipart bytes, retries 429 with Retry-After, and returns the typed asset', async () => {
    const { client, effects, server } = clientFor([{
      method: 'POST',
      match: SB_MEDIA_UPLOAD_PATH,
      responses: [
        { status: 429, headers: { 'retry-after': '4' }, json: { message: 'slow down' } },
        { status: 200, json: { mediaId: ID_1, assetId: ID_2, mediaType: 'IMAGE', status: 'COMPLETED', url: 'https://example.invalid/media' } },
      ],
    }]);

    const result = await client.uploadSbMedia(PROFILE_ID, {
      name: 'Synthetic image',
      mediaType: 'IMAGE',
      contentType: 'image/png',
      fileName: 'synthetic.png',
      bytes: new Uint8Array([0, 1, 2, 255]),
    });

    expect(result).toMatchObject({ mediaId: ID_1, assetId: ID_2, mediaType: 'IMAGE', status: 'COMPLETED' });
    expect(effects.slept).toEqual([4_000]);
    const requests = server.requestsFor(SB_MEDIA_UPLOAD_PATH);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers['content-type']).toBe(`multipart/form-data; boundary=${SB_MEDIA_MULTIPART_BOUNDARY}`);
    expect(requests[1]?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    const body = requests[1]?.bodyBytes;
    expect(body).not.toBeNull();
    expect(new TextDecoder().decode(body)).toContain('filename="synthetic.png"');
    expect(body?.slice(-4)).toEqual(new Uint8Array([45, 45, 13, 10]));
  });

  it('describes media by id and retries a throttled read', async () => {
    const { client, effects, server } = clientFor([{
      method: 'GET',
      match: SB_MEDIA_DESCRIBE_PATH,
      responses: [
        { status: 429, headers: { 'retry-after': '1' }, json: { message: 'slow down' } },
        { status: 200, json: { media: { mediaId: ID_1, assetId: ID_2, type: 'VIDEO', mediaStatus: 'PROCESSING', previewUrl: 'https://example.invalid/preview' } } },
      ],
    }]);

    const result = await client.getSbMedia(PROFILE_ID, ID_1);

    expect(result).toMatchObject({ mediaId: ID_1, assetId: ID_2, mediaType: 'VIDEO', status: 'PROCESSING' });
    expect(effects.slept).toEqual([1_000]);
    expect(server.requestsFor(SB_MEDIA_DESCRIBE_PATH)[1]?.url).toContain(`mediaId=${ID_1}`);
  });

  it('maps a 425 media upload to DuplicateWriteError without retrying', async () => {
    const { client, server } = clientFor([{
      method: 'POST',
      match: SB_MEDIA_UPLOAD_PATH,
      responses: [{ status: 425, json: { detail: 'duplicate media' } }],
    }]);

    const error = await client.uploadSbMedia(PROFILE_ID, {
      name: 'Synthetic image', mediaType: 'IMAGE', contentType: 'image/png', fileName: 'synthetic.png', bytes: new Uint8Array(),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DuplicateWriteError);
    expect(error).toMatchObject({ operation: 'upload', path: SB_MEDIA_UPLOAD_PATH, attempts: 1 });
    expect(server.requestsFor(SB_MEDIA_UPLOAD_PATH)).toHaveLength(1);
  });
});

describe('SB v4 creative create and update', () => {
  for (const operation of ['create', 'update'] as const) {
    const method = operation === 'create' ? 'POST' : 'PUT';

    it(`${operation} preserves a 207 partial failure and accounts for every submitted creative`, async () => {
      const { client, effects, server } = clientFor([{
        method,
        match: SB_CREATIVE_PATH,
        responses: [
          { status: 429, headers: { 'retry-after': '2' }, json: { message: 'slow down' } },
          { status: 207, json: {
            creatives: {
              success: [{ index: 0, creativeId: ID_1, creative: creative() }],
              error: [{ index: 1, code: 'INVALID_ARGUMENT', details: 'synthetic fixture rejection' }],
            },
          } },
        ],
      }]);

      const result = operation === 'create'
        ? await client.createSbCreatives(PROFILE_ID, [
            { adGroupId: ID_1, creativeType: 'VIDEO', assets: [{ assetId: ID_2, role: 'VIDEO' }] },
            { adGroupId: ID_1, creativeType: 'VIDEO', assets: [{ assetId: ID_2, role: 'VIDEO' }] },
          ])
        : await client.updateSbCreatives(PROFILE_ID, [
            { creativeId: ID_1, state: 'PAUSED' },
            { creativeId: ID_2, state: 'PAUSED' },
          ]);

      expect(result.items).toHaveLength(1);
      expect(result.errors).toMatchObject([{ index: 1, code: 'INVALID_ARGUMENT' }]);
      expect(result.items.length + result.errors.length).toBe(result.submitted);
      expect(result.submitted).toBe(2);
      expect(effects.slept).toEqual([2_000]);
      const request = server.requestsFor(SB_CREATIVE_PATH)[1];
      expect(request?.method).toBe(method);
      expect(request?.headers['content-type']).toBe(SB_CREATIVE_MEDIA_TYPE);
      expect(request?.headers['accept']).toBe(SB_CREATIVE_MEDIA_TYPE);
      expect((request?.json as { creatives: unknown[] }).creatives).toHaveLength(2);
    });

    it(`${operation} maps 425 to DuplicateWriteError without retrying`, async () => {
      const { client, server } = clientFor([{
        method,
        match: SB_CREATIVE_PATH,
        responses: [{ status: 425, json: { detail: 'duplicate creative batch' } }],
      }]);

      const error = operation === 'create'
        ? await client.createSbCreatives(PROFILE_ID, [{ adGroupId: ID_1, creativeType: 'VIDEO', assets: [{ assetId: ID_2, role: 'VIDEO' }] }]).catch((cause: unknown) => cause)
        : await client.updateSbCreatives(PROFILE_ID, [{ creativeId: ID_1, state: 'PAUSED' }]).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(DuplicateWriteError);
      expect(error).toMatchObject({ operation, path: SB_CREATIVE_PATH, attempts: 1 });
      expect(server.requestsFor(SB_CREATIVE_PATH)).toHaveLength(1);
    });
  }

  it('returns full representations from the single create/update convenience methods', async () => {
    const { client } = clientFor([{
      method: 'POST',
      match: SB_CREATIVE_PATH,
      responses: [{ status: 207, json: { creatives: { success: [{ index: 0, creativeId: ID_1, creative: creative() }], error: [] } } }],
    }, {
      method: 'PUT',
      match: SB_CREATIVE_PATH,
      responses: [{ status: 207, json: { creatives: { success: [{ index: 0, creativeId: ID_1, creative: creative(ID_1, 'PAUSED') }], error: [] } } }],
    }]);

    const created = await client.createSbCreative(PROFILE_ID, {
      adGroupId: ID_1, creativeType: 'VIDEO', assets: [{ assetId: ID_2, role: 'VIDEO' }],
    });
    const updated = await client.updateSbCreative(PROFILE_ID, { creativeId: ID_1, state: 'PAUSED' });

    expect(created.creativeId).toBe(ID_1);
    expect(updated.state).toBe('PAUSED');
  });

  it('rejects a mutation response that omits a submitted creative', async () => {
    const { client } = clientFor([{
      method: 'PUT',
      match: SB_CREATIVE_PATH,
      responses: [{ status: 207, json: { creatives: { success: [{ index: 0, creativeId: ID_1 }], error: [] } } }],
    }]);

    await expect(client.updateSbCreatives(PROFILE_ID, [
      { creativeId: ID_1, state: 'PAUSED' },
      { creativeId: ID_2, state: 'PAUSED' },
    ])).rejects.toBeInstanceOf(AdsApiParseError);
  });
});

describe('SB v4 creative list', () => {
  it('walks recorded pages, retries 429, and preserves the list filters', async () => {
    const { client, effects, server } = clientFor([{
      method: 'POST',
      match: SB_CREATIVE_LIST_PATH,
      responses: [
        { status: 429, headers: { 'retry-after': '3' }, json: { message: 'slow down' } },
        { status: 200, json: { creatives: [creative(ID_1)], nextToken: 'page-2' } },
        { status: 200, json: { creatives: [creative(ID_2, 'PAUSED')] } },
      ],
    }]);

    const result = await client.listSbCreatives(PROFILE_ID, {
      maxResults: 25,
      stateFilter: ['ENABLED', 'PAUSED'],
      adGroupIdFilter: [ID_1],
    });

    expect(result).toMatchObject({ pages: 2, truncated: false, nextToken: null });
    expect(result.items.map((item) => item.creativeId)).toEqual([ID_1, ID_2]);
    expect(effects.slept).toEqual([3_000]);
    const requests = server.requestsFor(SB_CREATIVE_LIST_PATH);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.json).toEqual({
      maxResults: 25,
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      adGroupIdFilter: { include: [ID_1] },
    });
    expect(requests[2]?.json).toMatchObject({ nextToken: 'page-2' });
    expect(requests[1]?.headers['content-type']).toBe(SB_CREATIVE_MEDIA_TYPE);
  });
});
