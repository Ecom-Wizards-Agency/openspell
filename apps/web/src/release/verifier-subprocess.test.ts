import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('release verifier subprocess boundary', () => {
  it('does not let pnpm or the verifier echo candidate or CDP credentials', () => {
    const candidateUsername = ['candidate', 'user'].join('-');
    const candidatePassword = ['candidate', 'password'].join('-');
    const candidateHostname = `${['wizard', 'synthetic', 'ecom', 'wizards'].join('-')}.vercel.app`;
    const cdpUsername = ['cdp', 'user'].join('-');
    const cdpPassword = ['cdp', 'password'].join('-');
    const cdpHostname = `${['private', 'cdp', 'host'].join('-')}.test`;
    const candidateUrl = `https://${candidateUsername}:${candidatePassword}@${candidateHostname}`;
    const cdpUrl = `https://${cdpUsername}:${cdpPassword}@${cdpHostname}:9222`;

    const result = spawnSync('pnpm', ['run', 'verify:release-candidate'], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        OPENSPELL_RELEASE_CANDIDATE_URL: candidateUrl,
        OPENSPELL_RELEASE_EXPECTED_REVISION: 'f'.repeat(40),
        OPENSPELL_CDP_URL: cdpUrl,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('OPENSPELL_RELEASE_ERROR:invalid_candidate');
    for (const sensitive of [
      candidateUrl,
      candidateUsername,
      candidatePassword,
      candidateHostname,
      cdpUrl,
      cdpUsername,
      cdpPassword,
      cdpHostname,
    ]) {
      expect(output).not.toContain(sensitive);
    }
  });
});
