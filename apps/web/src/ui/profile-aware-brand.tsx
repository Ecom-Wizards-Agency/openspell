'use client';

/** The home link keeps the current profile while dropping page-local parameters. */
import { useEffect, useState } from 'react';
import { OPENSPELL_BRAND_MARK_ARTIFACT } from './artifact-markers';

export function profileAwareHomeHref(currentUrl: string): string {
  const profileId = new URL(currentUrl).searchParams.get('profile');
  if (profileId === null) return '/';
  return `/?profile=${encodeURIComponent(profileId)}`;
}

export function ProfileAwareBrand(): React.ReactElement {
  const [href, setHref] = useState('/');

  useEffect(() => {
    setHref(profileAwareHomeHref(window.location.href));
  }, []);

  return (
    <a className="wa-brand" href={href}>
      <span
        aria-hidden="true"
        className="wa-brand-mark"
        data-release-artifact={OPENSPELL_BRAND_MARK_ARTIFACT}
      />
      <span className="wa-brand-label">OpenSpell</span>
    </a>
  );
}
