# `@wizard-ads/keepa-api`

Pure Keepa `/product` client for BSR, price, rating, review, coupon, and
Lightning Deal observations. Credentials arrive in the constructor; the package reads no
environment variables, filesystem, or database.

```ts
const keepa = new KeepaClient({ apiKey, fetch, now, sleep, random });
const result = await keepa.products(['B0TEST0001'], 'US');
```

`products()` normalizes and deduplicates ASINs, rejects unknown marketplaces, batches at
Keepa's 100-ASIN maximum, and throws `KeepaRetryableError` with an exact refill delay when
the known bucket cannot cover the next batch or Keepa responds with 429. The response's
`tokensLeft`, `refillIn`, `refillRate`, and `tokensConsumed` fields are the source of truth.

The default request uses `history=1`, `rating=1`, `buybox=1`, and `update=12`, matching the
daily reference pass and its measured four-token-per-ASIN budget. Coupon values are parsed
when Keepa supplies them. An absent or malformed coupon remains `null` (unknown), never an
empty coupon. A production live smoke should verify whether the subscribed Keepa plan
refreshes coupons under `buybox=1`; requesting offer pages would materially increase token
cost and is intentionally not enabled silently.
