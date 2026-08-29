import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_BUILD_EFFECT,
  parseCampaignBuildRequest,
} from './route.js';

describe('campaign build route contract', () => {
  it('only exposes preview and workbook export effects', () => {
    expect(CAMPAIGN_BUILD_EFFECT).toBe('export-only');
    expect(parseCampaignBuildRequest({ mode: 'create', config: {} })).toMatchObject({
      mode: 'create',
      output: 'preview',
      config: {},
    });
    expect(parseCampaignBuildRequest({ mode: 'update', output: 'xlsx', profileId: 'synthetic', config: {} }))
      .toMatchObject({ mode: 'update', output: 'xlsx', profileId: 'synthetic' });
  });

  it.each(['apply', 'write', 'publish'])('rejects the %s action before route work begins', (output) => {
    expect(() => parseCampaignBuildRequest({ mode: 'update', output, config: {} }))
      .toThrow('output must be preview or xlsx');
  });
});
