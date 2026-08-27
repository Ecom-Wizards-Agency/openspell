/** Pure Keepa `/product` client. */
export const PACKAGE_NAME = '@wizard-ads/keepa-api' as const;

export {
  KEEPA_API_URL,
  KEEPA_BUY_BOX_TOKENS_PER_ASIN,
  KEEPA_PRODUCT_BATCH_SIZE,
  KEEPA_PRODUCT_TOKENS_PER_ASIN,
  KeepaClient,
  normalizeAsins,
} from './client.js';
export { KEEPA_DOMAINS, domainId } from './domains.js';
export {
  KeepaConfigError,
  KeepaError,
  KeepaHttpError,
  KeepaParseError,
  KeepaRetryableError,
} from './errors.js';
export {
  CSV_BUY_BOX_PRICE,
  CSV_LIGHTNING_DEAL,
  CSV_NEW_PRICE,
  CSV_RATING,
  CSV_REVIEW_COUNT,
  CSV_SALES_RANK,
  KEEPA_EPOCH_MS,
  currentProductValues,
  currentValue,
  decodeHistory,
  keepaMinutesToDate,
  parseProduct,
} from './parsers.js';
export type {
  CurrentProductValues,
  FetchLike,
  KeepaClientOptions,
  KeepaCoupon,
  KeepaProduct,
  KeepaProductsResult,
  KeepaTokenState,
  ObservationPoint,
  ProductRequestOptions,
} from './types.js';
