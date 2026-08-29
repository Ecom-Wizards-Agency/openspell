import type { Page } from '@playwright/test';

/** Optional real-Chromium CPU throttle for reproducing hydration races locally and in CI. */
export async function applyRequestedCpuThrottle(page: Page): Promise<void> {
  const raw = process.env['WIZARD_ADS_E2E_CPU_RATE'];
  if (raw === undefined) return;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 1 || rate > 100) {
    throw new Error('WIZARD_ADS_E2E_CPU_RATE must be a number from 1 to 100');
  }
  if (rate === 1) return;
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}
