/** Minimal MCP client for My Real Profit product economics. */
export const PACKAGE_NAME = '@wizard-ads/mrp-api' as const;

export { MrpClient } from './client.js';
export { parseProductMetrics, parseSellerLine, parseSellers } from './parser.js';
export {
  MrpApiError,
  MrpAuthError,
  MrpConfigError,
  MrpHttpError,
  MrpParseError,
  MrpProtocolError,
  MrpTransportError,
  MrpToolCallError,
  MrpToolNotFoundError,
} from './errors.js';
export type {
  FetchLike,
  MrpClientOptions,
  MrpInitializeResult,
  MrpProductEconomics,
  MrpProductMetrics,
  MrpProductMetricsInput,
  MrpProductMetricsResult,
  MrpPeriod,
  MrpSeller,
  MrpSellersResult,
  MrpTool,
} from './types.js';
