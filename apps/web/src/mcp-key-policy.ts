/** Browser-safe policy shared by the issue form, route, and server data layer. */
export const MCP_KEY_EXPIRY_DAY_OPTIONS = [7, 30, 90] as const;
export const DEFAULT_MCP_KEY_EXPIRY_DAYS = 30;

export function isMcpKeyExpiryDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    MCP_KEY_EXPIRY_DAY_OPTIONS.some((candidate) => candidate === value)
  );
}
