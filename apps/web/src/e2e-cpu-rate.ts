/** Standard browser-suite CPU stress contract. Stronger stress needs a separate configuration. */
export const MAX_E2E_CPU_RATE = 10;

export function parseE2ECpuRate(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const rate = Number(raw);
  if (!Number.isInteger(rate) || rate < 1 || rate > MAX_E2E_CPU_RATE) {
    throw new Error(`WIZARD_ADS_E2E_CPU_RATE must be a whole number from 1 to ${MAX_E2E_CPU_RATE}`);
  }
  return rate;
}
