import { domainId } from './domains.js';
import { KeepaConfigError, KeepaError, KeepaRetryableError } from './errors.js';
import { keepaRequest, type HttpEffects, type TokenTracker } from './http.js';
import { isRecord, parseProduct } from './parsers.js';
import type {
  KeepaClientOptions,
  KeepaProductsResult,
  KeepaTokenState,
  ProductRequestOptions,
} from './types.js';

export const KEEPA_API_URL = 'https://api.keepa.com';
export const KEEPA_PRODUCT_BATCH_SIZE = 100;
export const KEEPA_PRODUCT_TOKENS_PER_ASIN = 2;
export const KEEPA_BUY_BOX_TOKENS_PER_ASIN = 4;

const ASIN = /^[A-Z0-9]{10}$/;

class Tokens implements TokenTracker {
  private state: KeepaTokenState = {
    tokensLeft: null,
    refillInMs: null,
    refillRate: null,
    tokensConsumed: 0,
    requestsMade: 0,
  };

  update(payload: unknown): void {
    if (!isRecord(payload)) return;
    const left = integer(payload['tokensLeft']);
    const refillIn = integer(payload['refillIn']);
    const refillRate = integer(payload['refillRate']);
    const consumed = integer(payload['tokensConsumed']);
    this.state = {
      ...this.state,
      ...(left === null ? {} : { tokensLeft: left }),
      ...(refillIn === null ? {} : { refillInMs: Math.max(0, refillIn) }),
      ...(refillRate === null || refillRate <= 0 ? {} : { refillRate }),
      tokensConsumed: this.state.tokensConsumed + Math.max(0, consumed ?? 0),
    };
  }

  recordRequest(): void {
    this.state = { ...this.state, requestsMade: this.state.requestsMade + 1 };
  }

  snapshot(): KeepaTokenState {
    return { ...this.state };
  }
}

export class KeepaClient {
  private readonly credential: string;
  private readonly effects: HttpEffects;
  private readonly now: () => number;
  private readonly tokens = new Tokens();

  constructor(options: KeepaClientOptions) {
    this.credential = options.apiKey.trim();
    if (!this.credential) throw new KeepaConfigError('Keepa API key cannot be empty');
    this.now = options.now ?? (() => Date.now());
    this.effects = {
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: options.random ?? (() => Math.random()),
      maxAttempts: Math.max(1, Math.trunc(options.maxAttempts ?? 3)),
    };
  }

  get tokenState(): KeepaTokenState {
    return this.tokens.snapshot();
  }

  async products(
    asins: readonly string[],
    marketplace: string,
    options: ProductRequestOptions = {},
  ): Promise<KeepaProductsResult> {
    const wanted = normalizeAsins(asins);
    if (wanted.length === 0) {
      return { requested: 0, returned: 0, missing: [], products: [], tokenState: this.tokenState };
    }
    const domain = domainId(marketplace);
    const history = options.history ?? true;
    const rating = options.rating ?? true;
    const buyBox = options.buyBox ?? true;
    const updateHours = options.updateHours === undefined ? 12 : options.updateHours;
    const found = new Map<string, ReturnType<typeof parseProduct>>();

    for (let start = 0; start < wanted.length; start += KEEPA_PRODUCT_BATCH_SIZE) {
      const batch = wanted.slice(start, start + KEEPA_PRODUCT_BATCH_SIZE);
      const cost = batch.length * (buyBox ? KEEPA_BUY_BOX_TOKENS_PER_ASIN : KEEPA_PRODUCT_TOKENS_PER_ASIN);
      this.assertBudget(cost);
      const url = new URL('/product', KEEPA_API_URL);
      url.searchParams.set('key', this.credential);
      url.searchParams.set('domain', String(domain));
      url.searchParams.set('asin', batch.join(','));
      url.searchParams.set('history', history ? '1' : '0');
      url.searchParams.set('rating', rating ? '1' : '0');
      url.searchParams.set('buybox', buyBox ? '1' : '0');
      if (updateHours !== null) url.searchParams.set('update', String(updateHours));

      const payload = await keepaRequest(this.effects, this.tokens, '/product', url.toString());
      if (payload['error']) throw new KeepaError('/product returned a Keepa error');
      const products = payload['products'];
      if (!Array.isArray(products)) throw new KeepaError('/product response has no products array');
      for (const raw of products) {
        const product = parseProduct(raw, this.now());
        found.set(product.asin, product);
      }
    }

    const products = wanted.flatMap((asin) => {
      const product = found.get(asin);
      return product ? [product] : [];
    });
    return {
      requested: wanted.length,
      returned: products.length,
      missing: wanted.filter((asin) => !found.has(asin)),
      products,
      tokenState: this.tokenState,
    };
  }

  private assertBudget(requiredTokens: number): void {
    const state = this.tokenState;
    if (state.tokensLeft === null || state.tokensLeft >= requiredTokens) return;
    const deficit = requiredTokens - state.tokensLeft;
    const firstRefill = state.refillInMs ?? 60_000;
    const laterCycles = state.refillRate === null
      ? 0
      : Math.max(0, Math.ceil((deficit - state.refillRate) / state.refillRate));
    throw new KeepaRetryableError(
      `Keepa needs ${requiredTokens} tokens but has ${state.tokensLeft}`,
      firstRefill + laterCycles * 60_000 + 1_000,
      state.tokensLeft,
      requiredTokens,
    );
  }
}

export function normalizeAsins(asins: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of asins) {
    const asin = value.trim().toUpperCase();
    if (!ASIN.test(asin)) throw new KeepaConfigError(`invalid ASIN ${JSON.stringify(value)}`);
    if (!seen.has(asin)) {
      seen.add(asin);
      out.push(asin);
    }
  }
  return out;
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
