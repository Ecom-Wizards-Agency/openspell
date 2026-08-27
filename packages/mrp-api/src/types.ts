import type { CurrencyCode, IsoDate } from '@wizard-ads/shared';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface MrpClientOptions {
  endpoint: string;
  token: string;
  fetch?: FetchLike;
}

export interface MrpInitializeResult {
  protocolVersion: string;
  serverName: string | null;
  serverVersion: string | null;
}

export interface MrpTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export interface MrpSeller {
  number: number;
  name: string;
  sellerId: number;
  sellingPartnerId: string | null;
  region: string | null;
  access: string | null;
}

export interface MrpProductEconomics {
  asin: string;
  salePrice: number | null;
  cogs: number | null;
  fbaFees: number | null;
  referralFees: number | null;
  otherFees: number | null;
  margin: number | null;
  ltvRevenue: number | null;
  ltvOrders: number | null;
  repeatRate: number | null;
  currency: CurrencyCode | null;
  details: Record<string, unknown>;
}

export interface MrpPeriod {
  from: IsoDate;
  to: IsoDate;
  days: number | null;
  complete: boolean | null;
  dataAvailableThrough: Record<string, IsoDate | null>;
  incompleteSources: string[];
  note: string | null;
}

export interface MrpProductMetrics {
  product: MrpProductEconomics;
  period: MrpPeriod;
}

export interface MrpProductMetricsInput {
  asin: string;
  sellerIds: number[];
  marketplaceIds: string[];
  dateFrom: IsoDate;
  dateTo: IsoDate;
}

export interface MrpSellersResult {
  toolName: string;
  sellers: MrpSeller[];
  ignoredLines: number;
}

export interface MrpProductMetricsResult {
  toolName: string;
  metrics: MrpProductMetrics;
}
