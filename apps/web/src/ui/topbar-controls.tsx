'use client';

/**
 * The two controls in the top bar that need a browser: the profile switcher and
 * the theme toggle.
 *
 * The profile switcher is in the frame rather than on each screen because the
 * recon's clearest structural finding about the incumbent is that tenancy is a
 * switchable parameter on every route, never a path prefix — so the switcher
 * belongs to the chrome and rewrites `?profile=` on whatever route you are
 * standing on. Screens that do not read the parameter simply ignore it.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { THEME_KEY } from './theme-script';

export interface NavProfile {
  id: string;
  label: string;
  countryCode: string;
}

/**
 * The switcher.
 *
 * The selected value is read from the URL after mount, so the server render is
 * a plain list with no assumption about which one is showing — and switching is
 * a navigation, which means the resulting URL is the shareable thing it should
 * have been all along.
 */
export function ProfileSwitcher({ profiles }: { profiles: readonly NavProfile[] }): ReactNode {
  const [selected, setSelected] = useState('');

  useEffect(() => {
    setSelected(new URL(window.location.href).searchParams.get('profile') ?? '');
  }, []);

  if (profiles.length === 0) return null;

  return (
    <label className="wa-row" style={{ gap: '0.375rem' }}>
      <span className="wa-sr-only">Profile</span>
      <select
        aria-label="Profile"
        className="wa-select wa-select--sm"
        data-testid="profile-switcher"
        style={{ maxWidth: '15rem', width: 'auto' }}
        value={selected}
        onChange={(event) => {
          const url = new URL(window.location.href);
          if (event.target.value === '') url.searchParams.delete('profile');
          else url.searchParams.set('profile', event.target.value);
          window.location.href = `${url.pathname}${url.search}`;
        }}
      >
        <option value="">All profiles</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.label} · {profile.countryCode}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Light or dark, chosen and remembered.
 *
 * Rendered as "follows the system" until the effect runs, because the honest
 * answer before mount is that we do not yet know what the document is set to.
 * The stamp itself is applied by the inline script in the root layout, which
 * runs before first paint so the page never flashes the wrong theme.
 */
export function ThemeToggle(): ReactNode {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const stamped = document.documentElement.getAttribute('data-theme');
    setTheme(stamped === 'dark' ? 'dark' : 'light');
  }, []);

  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      className="wa-btn wa-btn--ghost wa-btn--icon"
      data-testid="theme-toggle"
      onClick={() => {
        document.documentElement.setAttribute('data-theme', next);
        try {
          window.localStorage.setItem(THEME_KEY, next);
        } catch {
          // A blocked store means the choice lasts one session. Still worth it.
        }
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
