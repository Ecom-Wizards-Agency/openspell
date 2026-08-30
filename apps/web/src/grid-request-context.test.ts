/** Security and single-statement contract for the complete Grid request context. */
import { describe, expect, it } from 'vitest';
import type { RequestDatabase } from '@wizard-ads/db';
import {
  gridRequestSubject,
  gridRole,
  resolveGridReadReceipt,
} from './grid/request-context.js';
import { RequestAuthError } from './server/request-context.js';

const USER = '14141414-1414-4414-8414-141414141414';
const ORG = '25252525-2525-4525-8525-252525252525';
const PROFILE = '36363636-3636-4636-8636-363636363636';
const BRIDGE_SECRET = ['synthetic', 'grid', 'receipt', 'bridge'].join('-');
const SESSION_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

function runtime(userId: string | null, preferredOrgId: string | null) {
  return {
    verifiedSessionSubject: async () => userId,
    preferredOrganization: async () => preferredOrgId,
  };
}

function fakeHandle(rows: unknown[]) {
  const calls: unknown[][] = [];
  const sql = (async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return rows;
  }) as unknown as RequestDatabase['sql'];
  return { handle: { sql }, calls };
}

describe('Grid request subject', () => {
  it('uses a verified session subject and treats the org cookie only as a preference', async () => {
    await expect(
      gridRequestSubject(new Headers(), SESSION_ENV, runtime(USER, ORG)),
    ).resolves.toEqual({
      userId: USER,
      organization: { mode: 'preferred', orgId: ORG },
    });

    await expect(
      gridRequestSubject(new Headers(), SESSION_ENV, runtime(USER, 'not-an-org')),
    ).resolves.toEqual({
      userId: USER,
      organization: { mode: 'preferred', orgId: null },
    });
  });

  it('rejects a missing or malformed verified session subject as unauthenticated', async () => {
    for (const userId of [null, 'not-a-user']) {
      await expect(
        gridRequestSubject(new Headers(), SESSION_ENV, runtime(userId, ORG)),
      ).rejects.toMatchObject({ status: 401 });
    }
  });

  it('keeps the guarded bridge organization exact', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      WIZARD_ADS_E2E_AUTH_BRIDGE: '1',
      WIZARD_ADS_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
    };
    const headers = new Headers({
      'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
      'x-wizard-ads-user-id': USER,
      'x-wizard-ads-org-id': ORG,
    });
    const unexpectedSessionRuntime = {
      verifiedSessionSubject: async (): Promise<string | null> => {
        throw new Error('session verifier must not run for the bridge');
      },
      preferredOrganization: async (): Promise<string | null> => {
        throw new Error('org cookie must not run for the bridge');
      },
    };

    await expect(gridRequestSubject(headers, env, unexpectedSessionRuntime)).resolves.toEqual({
      userId: USER,
      organization: { mode: 'exact', orgId: ORG },
    });
  });

  it('refuses to arm the bridge alongside Supabase Auth', async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      WIZARD_ADS_E2E_AUTH_BRIDGE: '1',
      WIZARD_ADS_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.invalid',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-public-value',
    };

    await expect(gridRequestSubject(new Headers(), env, runtime(USER, ORG))).rejects.toThrow(
      'must never be enabled where real sessions exist',
    );
  });
});

describe('Grid read receipt', () => {
  it('resolves membership and profile facts in exactly one statement', async () => {
    const { handle, calls } = fakeHandle([
      { org_id: ORG, role: 'analyst', profile_id: PROFILE, currency_code: 'EUR' },
    ]);

    const receipt = await resolveGridReadReceipt(
      handle,
      { userId: USER, organization: { mode: 'preferred', orgId: ORG } },
      PROFILE,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([USER, false, ORG, false, ORG, PROFILE]);
    expect(receipt).toEqual({
      orgId: ORG,
      role: 'analyst',
      profileId: PROFILE,
      currencyCode: 'EUR',
    });
  });

  it('passes an exact bridge constraint and nullable profile candidate to the same statement', async () => {
    const { handle, calls } = fakeHandle([
      { org_id: ORG, role: 'owner', profile_id: null, currency_code: null },
    ]);

    const receipt = await resolveGridReadReceipt(
      handle,
      { userId: USER, organization: { mode: 'exact', orgId: ORG } },
      null,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([USER, true, ORG, true, ORG, null]);
    expect(receipt.profileId).toBeNull();
    expect(receipt.currencyCode).toBeNull();
  });

  it('maps unknown roles down to viewer and refuses a subject with no selected membership', async () => {
    expect(gridRole('future-role')).toBe('viewer');

    const { handle, calls } = fakeHandle([]);
    await expect(
      resolveGridReadReceipt(
        handle,
        { userId: USER, organization: { mode: 'exact', orgId: ORG } },
        PROFILE,
      ),
    ).rejects.toEqual(new RequestAuthError('Resource not found', 403));
    expect(calls).toHaveLength(1);
  });
});
