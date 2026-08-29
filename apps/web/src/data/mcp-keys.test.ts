import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import {
  issueMcpKey,
  listMcpKeys,
} from './mcp-keys';
import { MCP_KEY_EXPIRY_DAY_OPTIONS } from '../mcp-key-policy';

const available = await databaseAvailable();
const USER_A = '10101010-1010-4010-8010-101010101010';
const USER_B = '20202020-2020-4020-8020-202020202020';

describe.skipIf(!available)('MCP key data safety', () => {
  let database: TestDatabase;
  let orgA = '';
  let profileA = '';
  let profileB = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp54d_mcp_keys_data');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-data-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-data-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    const [ownProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [foreignProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${b?.seed_tenant_fixture ?? ''} limit 1
    `;
    profileA = ownProfile?.id ?? '';
    profileB = foreignProfile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('stores a read-only allowlist and the selected bounded expiry', async () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const issued = await issueMcpKey(database, {
      orgId: orgA,
      label: 'Synthetic client',
      profileIds: [profileA],
      expiresInDays: 30,
      now,
      createdBy: USER_A,
    });

    expect(issued.record.scope).toBe('read');
    expect(issued.record.profileIds).toEqual([profileA]);
    expect(new Date(issued.record.expiresAt ?? 0).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    const listed = await listMcpKeys(database, orgA);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.profileIds).toEqual([profileA]);
  });

  it('rejects missing profiles, unbounded expiry, and a profile from another org', async () => {
    await expect(
      issueMcpKey(database, { orgId: orgA, label: 'No profiles', profileIds: [] }),
    ).rejects.toThrow(/at least one profile/i);
    await expect(
      issueMcpKey(database, {
        orgId: orgA,
        label: 'Bad expiry',
        profileIds: [profileA],
        expiresInDays: Math.max(...MCP_KEY_EXPIRY_DAY_OPTIONS) + 1,
      }),
    ).rejects.toThrow(/expiry must be/i);

    const before = await listMcpKeys(database, orgA);
    await expect(
      issueMcpKey(database, {
        orgId: orgA,
        label: 'Foreign profile',
        profileIds: [profileA, profileB],
      }),
    ).rejects.toThrow(/belong to the active organization/i);
    const after = await listMcpKeys(database, orgA);
    expect(after).toHaveLength(before.length);
  });
});
