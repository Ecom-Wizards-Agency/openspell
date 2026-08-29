import { describe, expect, it } from 'vitest';
import { configFromEnv, revisionFromEnv } from './config.js';

describe('MCP configuration', () => {
  it('accepts only a sanitized Git object id for public revision metadata', () => {
    expect(revisionFromEnv({ WIZARD_ADS_MCP_REVISION: 'ABCDEF123456' })).toBe('abcdef123456');
    expect(revisionFromEnv({})).toBe('unknown');
    expect(() => revisionFromEnv({ WIZARD_ADS_MCP_REVISION: 'release/secret-looking-value' })).toThrow(
      '7-64 character hexadecimal Git object id',
    );
  });

  it('does not repeat a rejected revision value in the error', () => {
    const rejected = 'not-public-metadata';
    expect(() => revisionFromEnv({ WIZARD_ADS_MCP_REVISION: rejected })).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining(rejected) }),
    );
  });

  it('loads a database-backed production configuration with sanitized revision metadata', () => {
    const config = configFromEnv({
      WIZARD_ADS_MCP_DATABASE_URL: 'postgresql://localhost/wizard_ads_test',
      WIZARD_ADS_MCP_REVISION: '1234567abcdef',
    });

    expect(config.revision).toBe('1234567abcdef');
  });
});
