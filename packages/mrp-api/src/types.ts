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

export interface MrpProductEconomics {
  asin: string;
  capturedOn: IsoDate | null;
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

export interface MrpEconomicsResult {
  toolName: string;
  products: MrpProductEconomics[];
}
