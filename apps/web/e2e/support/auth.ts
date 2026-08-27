/**
 * Signing in, in a suite that cannot reach a mailbox.
 *
 * Sets the test-only session cookie the server honours when
 * `WIZARD_ADS_E2E_AUTH=1`. Everything after this line is the real application:
 * the same guard, the same org resolution, the same role table.
 */
import type { Page } from '@playwright/test';
import { E2E_USER_COOKIE, E2E_USER_EMAIL_COOKIE } from '../../src/cookies';
import { BASE_URL, EMAILS, USERS } from './fixture';
import type { UserKey } from './fixture';

export async function signIn(page: Page, who: UserKey): Promise<void> {
  await page.context().addCookies([
    { name: E2E_USER_COOKIE, value: USERS[who], url: BASE_URL, sameSite: 'Lax' },
    { name: E2E_USER_EMAIL_COOKIE, value: EMAILS[who], url: BASE_URL, sameSite: 'Lax' },
  ]);
}

export async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
}
