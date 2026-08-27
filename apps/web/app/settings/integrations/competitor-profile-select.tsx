'use client';

import { useState } from 'react';

export interface CompetitorProfileOption {
  id: string;
  label: string;
  countryCode: string;
  syncEnabled: boolean;
}

export function filterCompetitorProfiles(
  profiles: readonly CompetitorProfileOption[],
  showAll: boolean,
): CompetitorProfileOption[] {
  return profiles.filter((profile) => showAll || profile.syncEnabled);
}

/** Syncing profiles first, with the same explicit show-all escape as the top bar. */
export function CompetitorProfileSelect({
  profiles,
}: {
  profiles: readonly CompetitorProfileOption[];
}) {
  const [showAll, setShowAll] = useState(false);
  const [profileId, setProfileId] = useState('');
  const visible = filterCompetitorProfiles(profiles, showAll);
  const selected = visible.some((profile) => profile.id === profileId) ? profileId : '';
  const syncOffCount = profiles.filter((profile) => !profile.syncEnabled).length;

  return (
    <div className="wa-row" style={{ alignItems: 'end', gap: '0.5rem' }}>
      <label className="wa-field">
        <span className="wa-label">Profile / marketplace</span>
        <select
          className="wa-select"
          id="competitor-profile"
          name="profileId"
          required
          value={selected}
          onChange={(event) => setProfileId(event.target.value)}
        >
          <option value="" disabled>Select a profile</option>
          {visible.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} · {profile.countryCode}
            </option>
          ))}
        </select>
      </label>
      {syncOffCount === 0 ? null : (
        <button
          type="button"
          className="wa-btn wa-btn--ghost wa-btn--sm"
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? 'Show syncing profiles only' : `Show all profiles (${profiles.length})`}
        </button>
      )}
    </div>
  );
}
