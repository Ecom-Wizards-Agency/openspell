import { describe, expect, it } from 'vitest';
import type { ProfileRecord } from './profiles';
import { profilePreference, selectProfile } from './profiles';

const profile = (id: string, syncEnabled: boolean): ProfileRecord => ({
  id,
  amazonProfileId: `amazon-${id}`,
  label: id,
  region: 'NA',
  countryCode: 'US',
  currencyCode: 'USD',
  syncEnabled,
  targetAcos: null,
  monthlyBudget: null,
  goalLens: null,
  timezone: 'UTC',
});

describe('server profile selection', () => {
  const profiles = [profile('synced', true), profile('remembered', false)];

  it('uses a remembered profile only when the URL parameter is absent', () => {
    expect(selectProfile(profiles, profilePreference(undefined, 'remembered'))?.id).toBe(
      'remembered',
    );
    expect(selectProfile(profiles, profilePreference('synced', 'remembered'))?.id).toBe('synced');
  });

  it('validates URL and cookie preferences against the supplied organisation roster', () => {
    expect(selectProfile(profiles, profilePreference(undefined, 'outside-org'))?.id).toBe('synced');
    expect(selectProfile(profiles, profilePreference('outside-org', 'remembered'))?.id).toBe(
      'synced',
    );
  });
});
