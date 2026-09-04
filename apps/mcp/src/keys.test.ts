import { describe, expect, it } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { listApiKeys } from './keys.js';

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

function handleReturning(row: Record<string, unknown>): DbHandle {
  const sql = async () => [row];
  return { sql } as unknown as DbHandle;
}

function keyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    org_id: '00000000-0000-4000-8000-000000000003',
    label: 'bounded key',
    key_prefix: 'wza_example',
    scope: 'read',
    profile_ids: [PROFILE_ID],
    expires_at: '2099-01-01T00:00:00.000Z',
    revoked_at: null,
    last_used_at: '2026-09-04T02:00:00.000Z',
    created_at: '2026-09-04T01:00:00.000Z',
    ...overrides,
  };
}

describe('API key timestamp normalization', () => {
  it('returns Dates when the shared raw Postgres client yields timestamp strings', async () => {
    const [record] = await listApiKeys(handleReturning(keyRow()), 'org-id');

    expect(record?.expiresAt).toEqual(new Date('2099-01-01T00:00:00.000Z'));
    expect(record?.revokedAt).toBeNull();
    expect(record?.lastUsedAt).toEqual(new Date('2026-09-04T02:00:00.000Z'));
    expect(record?.createdAt).toEqual(new Date('2026-09-04T01:00:00.000Z'));
  });

  it('preserves Date instances returned by a client without Drizzle parsers', async () => {
    const createdAt = new Date('2026-09-04T01:00:00.000Z');
    const [record] = await listApiKeys(
      handleReturning(keyRow({ created_at: createdAt })),
      'org-id',
    );

    expect(record?.createdAt).toBe(createdAt);
  });

  it('refuses an invalid database timestamp', async () => {
    await expect(
      listApiKeys(handleReturning(keyRow({ created_at: 'not-a-timestamp' })), 'org-id'),
    ).rejects.toThrow('API key row contains an invalid timestamp');
  });
});
