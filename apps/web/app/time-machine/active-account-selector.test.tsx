// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActiveAccountSelector } from './active-account-selector';

function syntheticProfiles(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `profile-${index + 1}`,
    label: `Synthetic account ${index + 1}`,
    countryCode: index % 2 === 0 ? 'US' : 'DE',
  }));
}

describe('Time Machine active account selector', () => {
  it('renders every offered account exactly once inside one compact select, never as link navigation', () => {
    const profiles = syntheticProfiles(120);
    const markup = renderToStaticMarkup(
      <ActiveAccountSelector profiles={profiles} activeProfileId="profile-73" />,
    );
    const document = new DOMParser().parseFromString(markup, 'text/html');
    const selector = document.querySelector<HTMLSelectElement>('[data-testid="time-machine-profile"]');

    expect(selector).not.toBeNull();
    expect(selector?.options).toHaveLength(profiles.length);
    expect(selector?.value).toBe('profile-73');
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(document.querySelector('nav')).toBeNull();
  });

  it('submits only the selected org-scoped profile to the Time Machine route', () => {
    const markup = renderToStaticMarkup(
      <ActiveAccountSelector profiles={syntheticProfiles(2)} activeProfileId="profile-1" />,
    );
    const document = new DOMParser().parseFromString(markup, 'text/html');
    const form = document.querySelector<HTMLFormElement>('form');

    expect(form?.getAttribute('action')).toBe('/time-machine');
    expect(form?.getAttribute('method')).toBe('get');
    expect(form?.querySelectorAll('[name]')).toHaveLength(1);
    expect(form?.querySelector('[name="profile"]')).not.toBeNull();
  });
});
