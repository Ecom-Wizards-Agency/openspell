import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
const explorer = readFileSync(new URL('./creative-performance.tsx', import.meta.url), 'utf8');

describe('Creative Performance read-only boundary', () => {
  it('uses the authoritative database read without an Amazon client or mutation path', () => {
    expect(page).toContain('readCreativePerformance');
    expect(page).not.toContain('@wizard-ads/ads-api');
    expect(page).not.toMatch(/method=["']post["']/i);
    expect(page).not.toContain('server action');
    expect(explorer).not.toContain('@wizard-ads/ads-api');
    expect(explorer).not.toMatch(/fetch\s*\(/);
  });
});
