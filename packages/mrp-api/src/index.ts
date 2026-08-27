/** Minimal MCP client for My Real Profit product economics. */
export const PACKAGE_NAME = '@wizard-ads/mrp-api' as const;

export { MrpClient } from './client.js';
export { parseProductEconomics, selectEconomicsTool } from './parser.js';
export {
  MrpApiError,
  MrpAuthError,
  MrpConfigError,
  MrpHttpError,
  MrpParseError,
  MrpProtocolError,
  MrpToolCallError,
  MrpToolNotFoundError,
} from './errors.js';
export type {
  FetchLike,
  MrpClientOptions,
  MrpEconomicsResult,
  MrpInitializeResult,
  MrpProductEconomics,
  MrpTool,
} from './types.js';
