/** Public Amazon marketplace identifiers keyed by Ads profile country code. */
const MARKETPLACE_IDS: Readonly<Record<string, string>> = {
  CA: 'A2EUQ1WTGCTBG2',
  US: 'ATVPDKIKX0DER',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
  IE: 'A28R8C7NBKEWEA',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  FR: 'A13V1IB3VIYZZH',
  BE: 'AMEN7PMS3EDWL',
  NL: 'A1805IZSGTT6HS',
  DE: 'A1PA6795UKMFR9',
  IT: 'APJ6JRA9NG5V4',
  SE: 'A2NODRKZP88ZB9',
  ZA: 'AE08WJ6YKNBMC',
  PL: 'A1C3SOZRARQ6R3',
  EG: 'ARBP9OOSHTCHU',
  TR: 'A33AVAJ2PDY3EV',
  SA: 'A17E79C6D8DWNP',
  AE: 'A2VIGQ35RCS4UG',
  IN: 'A21TJRUUN4KGV',
  SG: 'A19VAU5U5O7RUS',
  AU: 'A39IBJ37TRP1C6',
  JP: 'A1VC38T7YXB528',
};

/** Amazon marketplace string id for a profile country code. */
export function marketplaceIdForCountry(countryCode: string): string | null {
  return MARKETPLACE_IDS[countryCode.trim().toUpperCase()] ?? null;
}
