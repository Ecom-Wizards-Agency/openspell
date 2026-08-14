/**
 * The header block every Amazon Ads request carries.
 *
 * Both client-id header spellings are sent. Amazon's reporting v3 guide
 * documents `Amazon-Ads-ClientId` and the campaign-management and profiles
 * endpoints document `Amazon-Advertising-API-ClientId`; both were used against
 * the live API by the two reference implementations. Sending the pair costs a
 * few bytes and removes a per-endpoint table that would eventually be wrong.
 *
 * `Amazon-Advertising-API-Scope` is the profile id and is what makes a request
 * tenant-scoped. `GET /v2/profiles` is the one call that must NOT carry it —
 * it is the call that discovers which profiles exist.
 */
import type { HeaderFactory } from './http.js';

export interface HeaderInput {
  clientId: string;
  /** Amazon's numeric profile id as a string. Omitted for `/v2/profiles`. */
  profileId?: string;
  contentType?: string;
  accept?: string;
  userAgent?: string;
}

/**
 * Build the per-attempt header factory.
 *
 * A factory rather than a value because the access token can change between
 * attempts: on a 401 the HTTP layer calls it with `force`, which mints a new
 * token before the retry.
 */
export function adsHeaders(
  getAccessToken: (force: boolean) => Promise<string>,
  input: HeaderInput,
): HeaderFactory {
  return async (force: boolean) => {
    const token = await getAccessToken(force);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': input.clientId,
      'Amazon-Ads-ClientId': input.clientId,
    };
    if (input.profileId !== undefined) {
      headers['Amazon-Advertising-API-Scope'] = input.profileId;
    }
    headers['Accept'] = input.accept ?? input.contentType ?? 'application/json';
    if (input.contentType !== undefined) headers['Content-Type'] = input.contentType;
    if (input.userAgent !== undefined) headers['User-Agent'] = input.userAgent;
    return headers;
  };
}
