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
 *
 * WP-24 makes it the AdLabs top-right dropdown: a trigger showing the active
 * profile, a popover with a search box, the profile list, and a "Manage
 * Profiles" link. Switching is still a navigation, so the resulting URL stays
 * the shareable thing it always should have been.
 *
 * The choice is also mirrored into `PROFILE_COOKIE` on the way out. The URL
 * remains the source of truth — nothing reads the cookie yet — and it exists so
 * a later server-side default can land a fresh visit on the profile the
 * operator last worked, rather than on "All profiles".
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PROFILE_COOKIE } from '../cookies';
import { THEME_KEY } from './theme-script';

export interface NavProfile {
  id: string;
  label: string;
  countryCode: string;
  syncEnabled: boolean;
}

export function filterNavProfiles(
  profiles: readonly NavProfile[],
  showAll: boolean,
  query: string,
): NavProfile[] {
  const needle = query.trim().toLowerCase();
  return profiles.filter(
    (profile) =>
      (showAll || profile.syncEnabled) &&
      (needle === '' ||
        profile.label.toLowerCase().includes(needle) ||
        profile.countryCode.toLowerCase().includes(needle)),
  );
}

export function ProfileSwitcher({ profiles }: { profiles: readonly NavProfile[] }): ReactNode {
  const [selected, setSelected] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSelected(new URL(window.location.href).searchParams.get('profile') ?? '');
  }, []);

  // Close on an outside click or Escape — a popover that only closes by
  // re-clicking the trigger is a popover an operator fights.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  if (profiles.length === 0) return null;

  const go = (profileId: string): void => {
    const url = new URL(window.location.href);
    if (profileId === '') {
      url.searchParams.delete('profile');
      // Chosen "All profiles" is a choice too; leaving a stale cookie behind
      // would quietly re-narrow the next visit.
      document.cookie = `${PROFILE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    } else {
      url.searchParams.set('profile', profileId);
      document.cookie = `${PROFILE_COOKIE}=${encodeURIComponent(profileId)}; path=/; max-age=31536000; SameSite=Lax`;
    }
    window.location.href = `${url.pathname}${url.search}`;
  };

  const active = profiles.find((profile) => profile.id === selected) ?? null;
  const matches = filterNavProfiles(profiles, showAll, query);
  const syncOffCount = profiles.filter((profile) => !profile.syncEnabled).length;

  return (
    <div className="wa-profile" ref={rootRef}>
      <button
        type="button"
        className="wa-profile-trigger"
        data-testid="profile-switcher"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Advertising profile"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wa-profile-trigger-label">
          {active === null ? 'All profiles' : `${active.label} · ${active.countryCode}`}
        </span>
        <svg aria-hidden="true" viewBox="0 0 10 10" className="wa-profile-caret">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open ? (
        <div className="wa-profile-menu" role="dialog" aria-label="Choose advertising profile">
          <input
            ref={searchRef}
            type="text"
            className="wa-input wa-input--sm wa-profile-search"
            placeholder="Search profiles…"
            aria-label="Search profiles"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="wa-profile-list" role="listbox" aria-label="Advertising profiles">
            <li>
              <button
                type="button"
                className="wa-profile-option"
                aria-selected={selected === ''}
                role="option"
                onClick={() => go('')}
              >
                <span>All profiles</span>
                {selected === '' ? <span aria-hidden="true">✓</span> : null}
              </button>
            </li>
            {matches.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  className={`wa-profile-option${profile.syncEnabled ? '' : ' wa-profile-option--sync-off'}`}
                  aria-selected={profile.id === selected}
                  role="option"
                  onClick={() => go(profile.id)}
                >
                  <span>
                    {profile.label} <span className="wa-hint">· {profile.countryCode}</span>
                    {profile.syncEnabled ? null : <span className="wa-hint"> · sync off</span>}
                  </span>
                  {profile.id === selected ? <span aria-hidden="true">✓</span> : null}
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="wa-profile-empty">No profile matches “{query}”.</li>
            ) : null}
            {syncOffCount > 0 ? (
              <li>
                <button
                  type="button"
                  className="wa-profile-option wa-profile-show-all"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? 'Show syncing profiles only' : `Show all profiles (${profiles.length})`}
                </button>
              </li>
            ) : null}
          </ul>
          {/* Leaves the popover for another screen; it should not also leave
              the profile behind. */}
          <a
            href={
              selected === ''
                ? '/settings/profiles'
                : `/settings/profiles?profile=${encodeURIComponent(selected)}`
            }
            className="wa-profile-manage"
          >
            Manage Profiles
          </a>
        </div>
      ) : null}
    </div>
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
