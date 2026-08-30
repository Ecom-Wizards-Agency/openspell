import type { CSSProperties, ReactNode } from 'react';
import type { OrgProfile } from '../../src/recommendations/data';
import { Button, Field, Select } from '../../src/ui/primitives';

type TimeMachineProfile = Pick<OrgProfile, 'id' | 'label' | 'countryCode'>;

/**
 * The timeline is scoped to exactly one org-owned advertising profile. Keep
 * that fact visible without laying the entire roster out as page navigation.
 * A GET deliberately resets profile-specific filters, cursors and batch state,
 * matching the previous account links while leaving selection server-owned.
 */
export function ActiveAccountSelector({
  profiles,
  activeProfileId,
}: {
  profiles: readonly TimeMachineProfile[];
  activeProfileId: string;
}): ReactNode {
  return (
    <form
      action="/time-machine"
      method="get"
      aria-label="Active account"
      data-testid="time-machine-active-account"
      style={accountSelector}
    >
      <Field
        label="Active account"
        htmlFor="time-machine-profile"
        hint="History below is scoped to this account."
      >
        <div style={accountControls}>
          <Select
            compact
            id="time-machine-profile"
            name="profile"
            defaultValue={activeProfileId}
            data-testid="time-machine-profile"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label} · {profile.countryCode}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm">
            Switch
          </Button>
        </div>
      </Field>
    </form>
  );
}

const accountSelector: CSSProperties = {
  alignItems: 'center',
  background: 'var(--wa-surface-2)',
  border: '1px solid var(--wa-border)',
  borderRadius: 'var(--wa-radius)',
  display: 'flex',
  flex: '0 1 22rem',
  maxWidth: '100%',
  minWidth: 0,
  padding: '0.625rem 0.75rem',
};

const accountControls: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: '0.5rem',
  width: '100%',
};
