export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.25,
  maxRetryAfterMs: 120_000,
};

export interface DataDiveRetryEvent {
  path: string;
  attempt: number;
  reason: 'throttled' | 'server-error' | 'transport-error';
  delayMs: number;
  retryAfterMs: number | null;
}

export interface DataDiveClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  retry?: Partial<RetryPolicy>;
  onRetry?: (event: DataDiveRetryEvent) => void;
}

export interface RankRadar {
  id: string;
  asin: string;
  marketplace: string;
  keywordCount: number;
  title: string;
  imageUrl: string;
  details: Record<string, unknown>;
}

export interface RankRadarList {
  items: RankRadar[];
  pages: number;
  total: number;
}

export interface RankPoint {
  date: string;
  organicRank: number | null;
  details: Record<string, unknown>;
}

export interface RankKeyword {
  id: string;
  keyword: string;
  searchVolume: number | null;
  ranks: RankPoint[];
  details: Record<string, unknown>;
}

export interface RankRadarData {
  keywords: RankKeyword[];
  details: Record<string, unknown>;
}

export interface RankRadarDateRange {
  startDate: string;
  endDate: string;
}

export interface QuotaFeature {
  used: number | null;
  capacity: number | null;
  details: Record<string, unknown>;
}

export interface DataDiveQuota {
  nextRefreshDate: string | null;
  features: Record<string, QuotaFeature> & { RANK_RADAR_KEYWORDS: QuotaFeature };
  details: Record<string, unknown>;
}
