import { describe, expect, it } from 'vitest';
import {
  OPTIMIZER_PREVIEW_BODY_MAX_BYTES,
  parseOptimizerPreviewRequest,
  readOptimizerPreviewRequest,
} from './preview-http';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID = '00000000-0000-4000-8000-000000000002';

describe('optimizer preview HTTP input', () => {
  it('accepts exact all and selected request shapes', () => {
    expect(parseOptimizerPreviewRequest({
      profileId: PROFILE_ID,
      clientRequestId: REQUEST_ID,
      scope: { mode: 'all' },
    })).toEqual({
      profileId: PROFILE_ID,
      clientRequestId: REQUEST_ID,
      scope: { mode: 'all' },
    });
    expect(parseOptimizerPreviewRequest({
      profileId: PROFILE_ID,
      clientRequestId: REQUEST_ID,
      scope: { mode: 'selected', campaignIds: ['campaign-2', 'campaign-1'] },
    })).toEqual({
      profileId: PROFILE_ID,
      clientRequestId: REQUEST_ID,
      scope: { mode: 'selected', campaignIds: ['campaign-2', 'campaign-1'] },
    });
  });

  it.each([
    [{}, 'profileId must be a UUID'],
    [{ profileId: PROFILE_ID, clientRequestId: 'not-a-uuid', scope: { mode: 'all' } }, 'clientRequestId must be a UUID'],
    [{ profileId: PROFILE_ID, clientRequestId: REQUEST_ID, scope: { mode: 'all', campaignIds: [] } }, 'All scope must not include campaignIds'],
    [{ profileId: PROFILE_ID, clientRequestId: REQUEST_ID, scope: { mode: 'selected', campaignIds: [] } }, 'Select at least one campaign'],
    [{ profileId: PROFILE_ID, clientRequestId: REQUEST_ID, scope: { mode: 'selected', campaignIds: ['same', 'same'] } }, 'campaignIds must be unique'],
    [{ profileId: PROFILE_ID, clientRequestId: REQUEST_ID, scope: { mode: 'selected', campaignIds: [' padded '] } }, 'campaignIds must contain non-empty canonical strings'],
  ])('rejects the request atomically %#', (value, message) => {
    expect(() => parseOptimizerPreviewRequest(value)).toThrow(message as string);
  });

  it('enforces the byte bound while streaming when Content-Length is absent', async () => {
    const body = new Uint8Array(OPTIMIZER_PREVIEW_BODY_MAX_BYTES + 1).fill(32);
    const request = new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      body,
    });
    request.headers.delete('content-length');
    await expect(readOptimizerPreviewRequest(request)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a declared oversized body before reading it', async () => {
    const request = new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      headers: { 'content-length': String(OPTIMIZER_PREVIEW_BODY_MAX_BYTES + 1) },
      body: '{}',
    });
    await expect(readOptimizerPreviewRequest(request)).rejects.toMatchObject({ status: 413 });
  });

  it('reads and validates a bounded JSON stream', async () => {
    const value = {
      profileId: PROFILE_ID,
      clientRequestId: REQUEST_ID,
      scope: { mode: 'selected', campaignIds: ['campaign-1'] },
    };
    const request = new Request('http://localhost/api/optimizer/runs', {
      method: 'POST',
      body: JSON.stringify(value),
    });
    await expect(readOptimizerPreviewRequest(request)).resolves.toEqual(value);
  });
});
