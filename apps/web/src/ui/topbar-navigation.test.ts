// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_COOKIE } from '../cookies';
import { ProfileSwitcher } from './topbar-controls';

const navigation = vi.hoisted(() => ({ push: vi.fn<(href: string) => void>() }));

vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ unmount: () => void }> = [];
const profiles = [
  { id: 'profile-current', label: 'Current', countryCode: 'US', syncEnabled: true },
  { id: 'profile-next', label: 'Next', countryCode: 'CA', syncEnabled: true },
] as const;

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  navigation.push.mockReset();
  document.body.replaceChildren();
  document.cookie = `${PROFILE_COOKIE}=; path=/; max-age=0`;
});

describe('profile App Router navigation', () => {
  it('writes the profile cookie before requesting the next RSC and preserves route state', () => {
    const currentRoute = new URLSearchParams({
      profile: 'profile-current',
      entity: 'targets',
      from: '2026-08-01',
      batch: 'profile-bound-preview',
    });
    window.history.replaceState(
      null,
      '',
      `/grid?${currentRoute.toString()}`,
    );
    let cookieAtPush = '';
    navigation.push.mockImplementation(() => {
      cookieAtPush = document.cookie;
    });

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(createElement(ProfileSwitcher, { profiles })));
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="profile-switcher"]')?.click());
    const next = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((button) => button.textContent?.includes('Next'));
    act(() => next?.click());

    expect(cookieAtPush).toContain(`${PROFILE_COOKIE}=profile-next`);
    expect(navigation.push).toHaveBeenCalledWith(
      '/grid?profile=profile-next&entity=targets&from=2026-08-01',
    );
  });
});
