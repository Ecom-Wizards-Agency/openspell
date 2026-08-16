/**
 * The profile switcher.
 *
 * Renders links, not a client-side store, so switching profile is a navigation
 * an operator can bookmark, share and open in a second tab — and so the server
 * component behind it re-reads the right tenant's data instead of a cache
 * keyed on the wrong one.
 *
 * The currency is on the face of every option deliberately. v1 has no FX layer
 * and no cross-currency aggregation (`aggregate.ts` throws rather than summing
 * two currencies), so which currency a page is denominated in has to be
 * visible at the moment the operator chooses it, not discovered from a `€` in
 * a cell three scrolls down.
 */
import type { CSSProperties, ReactNode } from 'react';
import { tokens } from './theme.js';

export interface ProfileOption {
  /** Our uuid, the one the routes take. */
  id: string;
  label: string;
  region: string;
  countryCode: string;
  currencyCode: string;
  /** Whether the sync is paying for this profile's reports. */
  syncEnabled: boolean;
}

export function ProfileSwitcher({
  profiles,
  selectedId,
  hrefFor,
}: {
  profiles: readonly ProfileOption[];
  selectedId: string | null;
  hrefFor: (profileId: string) => string;
}): ReactNode {
  if (profiles.length === 0) {
    return (
      <p style={{ color: tokens.color.textMuted, fontSize: tokens.font.size.sm }}>
        No advertising profiles yet. Connect an account and enable sync on a profile to see one here.
      </p>
    );
  }

  return (
    <nav aria-label="Advertising profile" style={nav}>
      {profiles.map((profile) => {
        const selected = profile.id === selectedId;
        return (
          <a
            key={profile.id}
            href={hrefFor(profile.id)}
            aria-current={selected ? 'page' : undefined}
            style={{
              ...tab,
              ...(selected ? tabSelected : {}),
              ...(profile.syncEnabled ? {} : { opacity: 0.6 }),
            }}
            title={profile.syncEnabled ? undefined : 'Sync is off for this profile: its figures will not refresh.'}
          >
            <span style={{ fontWeight: selected ? 600 : 400 }}>{profile.label}</span>
            <span style={meta}>
              {profile.region} · {profile.countryCode} · {profile.currencyCode}
              {profile.syncEnabled ? '' : ' · sync off'}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

const nav: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  fontFamily: tokens.font.sans,
  gap: tokens.space(2),
};

const tab: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.text,
  display: 'flex',
  flexDirection: 'column',
  fontSize: tokens.font.size.sm,
  gap: '0.125rem',
  padding: `${tokens.space(1)} ${tokens.space(2.5)}`,
  textDecoration: 'none',
};

const tabSelected: CSSProperties = {
  background: tokens.color.accentSoft,
  borderColor: 'var(--wa-accent-border, #bfdbfe)',
};

const meta: CSSProperties = { color: tokens.color.textMuted, fontSize: tokens.font.size.xs };
