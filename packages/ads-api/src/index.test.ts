/**
 * The public surface, asserted rather than assumed.
 *
 * Two packages are built against this one in parallel: the worker uses the
 * client, and the web app's OAuth callback uses the LWA code exchange and the
 * profile fetch — the one sanctioned exception to "apps/web never imports
 * ads-api". A rename here is a build break there, so the names are pinned.
 */
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('@wizard-ads/ads-api', () => {
  it('is wired into the workspace', () => {
    expect(api.PACKAGE_NAME).toBe('@wizard-ads/ads-api');
  });

  it('exports the OAuth surface WP-04 consumes', () => {
    expect(typeof api.buildAuthorizationUrl).toBe('function');
    expect(typeof api.exchangeAuthorizationCode).toBe('function');
    expect(typeof api.refreshAccessToken).toBe('function');
    expect(typeof api.listProfiles).toBe('function');
    expect(typeof api.listProfilesAcrossRegions).toBe('function');
    expect(typeof api.AdsApiClient.prototype.getProfiles).toBe('function');
  });

  it('exports the sync surface WP-03 consumes', () => {
    for (const method of [
      'listSpCampaigns',
      'listSpAdGroups',
      'listSpKeywords',
      'listSpTargets',
      'listSpNegativeKeywords',
      'listSpCampaignNegativeKeywords',
      'listSpNegativeTargets',
      'listSpProductAds',
      'listSbCampaigns',
      'listSbAdGroups',
      'listSdCampaigns',
      'listSdAdGroups',
      'createReport',
      'getReport',
      'downloadReport',
      'createExport',
      'getExport',
      'downloadExport',
      'getBudgetUsage',
    ]) {
      const prototype = api.AdsApiClient.prototype as unknown as Record<string, unknown>;
      expect(typeof prototype[method], method).toBe('function');
    }
  });

  it('exports one parser per report type in the contract', () => {
    expect(Object.keys(api.REPORT_SPECS).sort()).toEqual([
      'sbCampaigns',
      'sdCampaigns',
      'spCampaigns',
      'spPlacement',
      'spSearchTerm',
      'spTargeting',
    ]);
    for (const parser of [
      api.parseSpCampaignReport,
      api.parseSpTargetingReport,
      api.parseSpSearchTermReport,
      api.parseSpPlacementReport,
      api.parseSbCampaignReport,
      api.parseSdCampaignReport,
    ]) {
      expect(typeof parser).toBe('function');
    }
  });

  it('exports the error types a caller has to branch on', () => {
    expect(new api.AdsThrottleError('x', 429, '', 1, null)).toBeInstanceOf(api.AdsApiError);
    expect(new api.DuplicateReportError('x', 425, '', 1, null)).toBeInstanceOf(api.AdsApiHttpError);
    expect(new api.AdsAuthError('x', 401, '', 1)).toBeInstanceOf(api.AdsApiHttpError);
  });
});
