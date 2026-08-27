import { KeepaConfigError } from './errors.js';

/** Profile-country code to Keepa locale id, ported from the reference client. */
export const KEEPA_DOMAINS: Readonly<Record<string, number>> = Object.freeze({
  US: 1,
  UK: 2,
  GB: 2,
  DE: 3,
  FR: 4,
  JP: 5,
  CA: 6,
  IT: 8,
  ES: 9,
  IN: 10,
  MX: 11,
  BR: 12,
  AU: 13,
  AUS: 13,
  NL: 14,
  SE: 15,
  PL: 16,
  BE: 17,
  TR: 18,
  AE: 19,
  SG: 20,
});

export function domainId(marketplace: string): number {
  const normalized = marketplace.trim().toUpperCase();
  const id = KEEPA_DOMAINS[normalized];
  if (id === undefined) {
    throw new KeepaConfigError(`no Keepa domain for marketplace ${JSON.stringify(marketplace)}`);
  }
  return id;
}
