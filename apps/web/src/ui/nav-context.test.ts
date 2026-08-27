import { describe, expect, it } from 'vitest';
import { mapNavProfiles } from './nav-context';
import { filterNavProfiles } from './topbar-controls';

const profiles = [
  { id: 'profile-on', label: 'Active account', countryCode: 'US', syncEnabled: true },
  { id: 'profile-off', label: 'Paused account', countryCode: 'CA', syncEnabled: false },
] as const;

describe('navigation profile roster', () => {
  it('carries every roster row and its sync state into the frame', () => {
    const mapped = mapNavProfiles(profiles);

    expect(mapped).toHaveLength(profiles.length);
    expect(mapped).toEqual(profiles);
  });

  it('defaults to syncing profiles and reveals sync-off matches only on request', () => {
    expect(filterNavProfiles(profiles, false, '')).toEqual([profiles[0]]);
    expect(filterNavProfiles(profiles, false, 'paused')).toEqual([]);
    expect(filterNavProfiles(profiles, true, 'paused')).toEqual([profiles[1]]);
    expect(filterNavProfiles(profiles, true, '')).toHaveLength(profiles.length);
  });
});
