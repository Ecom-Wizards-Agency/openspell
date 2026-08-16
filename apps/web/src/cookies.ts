/**
 * Cookie names, in a module that imports nothing.
 *
 * Separated from the modules that use them so the end-to-end suite can read the
 * names without importing `next/headers`, which only works inside a request.
 * A duplicated string literal in a test is a bug waiting for a rename.
 */

/** The active org. Always validated against membership; never trusted alone. */
export const ORG_COOKIE = 'wizard_ads_org';

/**
 * The advertising profile last chosen in the top bar's switcher.
 *
 * The URL's `?profile=` stays the source of truth — it is what makes a screen
 * shareable — and this only remembers the last choice so a fresh entry into the
 * app can land on it instead of on "All profiles". Written by the switcher;
 * nothing reads it yet.
 */
export const PROFILE_COOKIE = 'wizard_ads_profile';

/** Test-only session. Honoured only when `WIZARD_ADS_E2E_AUTH=1`. */
export const E2E_USER_COOKIE = 'wizard_ads_e2e_user';
