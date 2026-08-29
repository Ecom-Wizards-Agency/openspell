import type { Page } from '@playwright/test';
import { parseE2ECpuRate } from '../../src/e2e-cpu-rate.js';

/** Optional real-Chromium CPU throttle for reproducing hydration races locally and in CI. */
export async function applyRequestedCpuThrottle(page: Page): Promise<void> {
  const rate = parseE2ECpuRate(process.env['WIZARD_ADS_E2E_CPU_RATE']);
  if (rate === null || rate === 1) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}
