import { describe, expect, it } from 'vitest';
import {
  formatMarketingStreamRecoveryResult,
  parseMarketingStreamRecoveryArgs,
} from './marketing-stream-recovery-cli.js';

describe('Marketing Stream recovery CLI', () => {
  it('requires explicit organization and profile UUID arguments', () => {
    expect(parseMarketingStreamRecoveryArgs([
      '--org-id', '81818181-8181-4181-8181-818181818181',
      '--profile-id', '82828282-8282-4282-8282-828282828282',
    ])).toEqual({
      orgId: '81818181-8181-4181-8181-818181818181',
      profileId: '82828282-8282-4282-8282-828282828282',
    });
    expect(() => parseMarketingStreamRecoveryArgs(['--profile-id', 'synthetic'])).toThrow(/usage/);
    expect(() => parseMarketingStreamRecoveryArgs(['--unknown', 'synthetic'])).toThrow(/usage/);
  });

  it('prints an auditable result with the exact profile, action, and pending count', () => {
    expect(JSON.parse(formatMarketingStreamRecoveryResult(
      {
        orgId: '81818181-8181-4181-8181-818181818181',
        profileId: '82828282-8282-4282-8282-828282828282',
      },
      {
        action: 'revived',
        jobId: '83838383-8383-4383-8383-838383838383',
        blockToken: '84848484-8484-4484-8484-848484848484',
        pendingScopes: 300,
        dedupeKey: 'synthetic-recovery-key',
      },
    ))).toEqual({
      orgId: '81818181-8181-4181-8181-818181818181',
      profileId: '82828282-8282-4282-8282-828282828282',
      action: 'revived',
      jobId: '83838383-8383-4383-8383-838383838383',
      blockToken: '84848484-8484-4484-8484-848484848484',
      pendingScopes: 300,
      dedupeKey: 'synthetic-recovery-key',
    });
  });
});
