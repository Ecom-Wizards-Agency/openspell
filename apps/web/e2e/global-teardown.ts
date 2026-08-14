/**
 * Close what global setup opened.
 *
 * The closure lives on `globalThis` because Playwright runs setup and teardown
 * in the same process but gives them no shared value; a module-level variable
 * would work only as long as both files are loaded from the same module
 * instance, which is a fragile thing to rely on.
 */
export default async function globalTeardown(): Promise<void> {
  const stop = (globalThis as Record<string, unknown>)['__wizardAdsE2E'];
  if (typeof stop === 'function') await (stop as () => Promise<void>)();
}
