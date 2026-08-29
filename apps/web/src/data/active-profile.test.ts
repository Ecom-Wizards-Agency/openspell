import { describe, expect, it } from 'vitest';
import {
  canonicalProfilePath,
  orderActiveProfiles,
  resolveActiveProfile,
} from './active-profile.js';

const profile = (id: string, label: string, syncEnabled: boolean) => ({
  id,
  label,
  syncEnabled,
});

describe('active advertising profile', () => {
  const unsynced = profile('00000000-0000-4000-8000-000000000001', 'Alpha', false);
  const syncedB = profile('00000000-0000-4000-8000-000000000003', 'beta', true);
  const syncedA = profile('00000000-0000-4000-8000-000000000002', 'Beta', true);

  it('orders every adapter roster by one deterministic label and id rule', () => {
    const input = [syncedB, unsynced, syncedA];

    expect(orderActiveProfiles(input).map(({ id }) => id)).toEqual([
      unsynced.id,
      syncedA.id,
      syncedB.id,
    ]);
    expect(input.map(({ id }) => id)).toEqual([syncedB.id, unsynced.id, syncedA.id]);
  });

  it('uses a valid request and otherwise falls back to the first syncing profile', () => {
    const input = [syncedB, unsynced, syncedA];

    expect(resolveActiveProfile(input, syncedB.id)?.id).toBe(syncedB.id);
    expect(resolveActiveProfile(input, '00000000-0000-4000-8000-000000000099')?.id).toBe(
      syncedA.id,
    );
    expect(resolveActiveProfile([profile('b', 'Zulu', false), unsynced], undefined)?.id).toBe(
      unsynced.id,
    );
    expect(resolveActiveProfile([], undefined)).toBeNull();
  });

  it('canonicalizes missing, invalid, empty, and repeated profile parameters', () => {
    const active = syncedA.id;

    expect(canonicalProfilePath('/dashboard', {}, active)).toBe(`/dashboard?profile=${active}`);
    expect(canonicalProfilePath('/grid', { profile: '', entity: 'campaigns' }, active)).toBe(
      `/grid?profile=${active}&entity=campaigns`,
    );
    expect(
      canonicalProfilePath(
        '/creative',
        { profile: [active, syncedB.id], from: '2026-08-01' },
        active,
      ),
    ).toBe(`/creative?profile=${active}&from=2026-08-01`);
    expect(canonicalProfilePath('/optimizer', { profile: active, run: 'run 1' }, active)).toBeNull();
  });

  it('preserves repeated and encoded page state while replacing the profile', () => {
    const result = canonicalProfilePath(
      '/recommendations',
      { profile: syncedB.id, reason: ['high spend', 'low/visibility'], run: 'run&one' },
      syncedA.id,
    );
    const url = new URL(result ?? '', 'https://example.test');

    expect(url.pathname).toBe('/recommendations');
    expect(url.searchParams.get('profile')).toBe(syncedA.id);
    expect(url.searchParams.getAll('reason')).toEqual(['high spend', 'low/visibility']);
    expect(url.searchParams.get('run')).toBe('run&one');
  });
});
