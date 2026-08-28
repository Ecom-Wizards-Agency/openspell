export interface SpApiAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init?: Omit<RequestInit, 'body'> & { body?: string | Uint8Array },
) => Promise<Response>;

export interface SpApiClientOptions {
  /** Regional SP-API endpoint, supplied by the worker. */
  endpoint: string;
  accessTokenProvider: SpApiAccessTokenProvider;
  /** Amazon requires a descriptive user agent. It must not contain credentials. */
  userAgent: string;
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  maxRetries?: number;
}

export interface CreateReportInput {
  reportType: string;
  marketplaceId: string;
  dataStartTime: string;
  dataEndTime: string;
  reportOptions?: Record<string, string>;
}

export interface SpApiReport {
  reportId: string;
  reportType: string | null;
  processingStatus: string;
  reportDocumentId: string | null;
  createdTime: string | null;
}

export interface SpApiReportDocument {
  reportDocumentId: string;
  url: string;
  compressionAlgorithm: 'GZIP' | null;
}
