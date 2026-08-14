/**
 * The read side of the analyst: a thin, typed wrapper over the MCP client.
 *
 * Every account number the analyst reasons about comes through here, and here
 * only. The wrapper exposes the read tools and the per-profile context resource
 * and nothing else — there is no method that calls a write tool, so a bug
 * cannot accidentally reach one. That is the same guarantee the read-only key
 * enforces at the server, stated a second time in the client's own shape.
 *
 * The MCP tools return their payload as a single JSON text block. `parseJson`
 * unwraps it and refuses an `isError` result loudly: a headless run that
 * silently treats an error page as data is how a digest ends up quoting zeros
 * that were really a failed query.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ANALYST_CLIENT_NAME = 'wizard-ads-analyst';
export const ANALYST_CLIENT_VERSION = '0.1.0';

/** A profile as `list_profiles` returns it. A subset of the server's row: the fields the analyst reads. */
export interface McpProfile {
  id: string;
  amazonProfileId: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  accountName: string | null;
  syncEnabled: boolean;
  targetAcos: number | null;
  goalLens: string | null;
  monthlyBudget: number | null;
}

export interface McpProfileList {
  org: string;
  count: number;
  profiles: McpProfile[];
}

export type FactRow = Record<string, string | number | boolean | null>;

export interface EntityDataPayload {
  entity: string;
  window: { from: string; to: string };
  comparisonWindow: { from: string; to: string } | null;
  columns: { name: string; kind: string }[];
  rowCount: number;
  rows: FactRow[];
  freshness: { latestFactDate: string | null; provisional: boolean | null; note: string };
}

export interface FlagRecord {
  severity: 'critical' | 'alert' | 'warn' | 'info';
  metric: string;
  message: string;
  likelyCause: string;
  scope: string;
  suppressed: boolean;
  suppressedReason: string | null;
}

export interface FlagsPayload {
  asOf: string | null;
  provisional?: boolean;
  goalLens?: { key: string; label: string; description: string };
  active?: FlagRecord[];
  suppressed?: FlagRecord[];
  note?: string;
}

export interface PacingPayload {
  asOf: string | null;
  pacing?: {
    status: string;
    pace: number | null;
    monthToDateSpend?: number | null;
    monthlyBudget?: number | null;
  } | null;
  note?: string;
}

export interface SyncStatusPayload {
  profileId: string;
  syncEnabled: boolean;
  latestFactDate: string | null;
  latestFactProvisional: boolean | null;
}

/** The context resource, reduced to the fields the briefing quotes. Unknown extras are ignored. */
export interface ProfileContextPayload {
  strategySummary: {
    present: boolean;
    scope: 'profile' | 'org' | null;
    sections: string[];
    refreshedAt: string | null;
  };
  counts: { campaigns: number; adGroups: number; keywords: number; targets: number };
  recentChanges: { field: string; entityName: string | null; source: string }[];
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface AnalystMcpClient {
  listProfiles(): Promise<McpProfileList>;
  readProfileContext(profileId: string): Promise<ProfileContextPayload>;
  getSyncStatus(profileId: string): Promise<SyncStatusPayload>;
  getEntityData(args: {
    entity: string;
    profileId: string;
    dateRange: { start: string; end: string };
    compare?: boolean;
  }): Promise<EntityDataPayload>;
  getFlags(profileId: string, asOf?: string): Promise<FlagsPayload>;
  getPacing(profileId: string, asOf?: string): Promise<PacingPayload>;
  close(): Promise<void>;
}

function parseJson<T>(result: ToolResult, tool: string): T {
  const block = result.content?.find((entry) => entry.type === 'text');
  const text = block?.text;
  if (text === undefined) {
    throw new Error(`${tool} returned no text content`);
  }
  const payload = JSON.parse(text) as unknown;
  if (result.isError) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : text;
    throw new Error(`${tool} failed: ${message}`);
  }
  return payload as T;
}

/**
 * Connect to the MCP server with a read-only bearer key.
 *
 * The token rides in the `Authorization` header of every request the transport
 * makes; it is never placed in a tool argument, so it cannot leak into
 * `audit_log.payload`, which records arguments verbatim.
 */
export async function connectMcp(opts: {
  url: string;
  token: string;
}): Promise<AnalystMcpClient> {
  const client = new Client({ name: ANALYST_CLIENT_NAME, version: ANALYST_CLIENT_VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  });
  await client.connect(transport);

  const callTool = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    return parseJson<T>(result, name);
  };

  return {
    listProfiles: () => callTool<McpProfileList>('list_profiles', {}),
    readProfileContext: async (profileId) => {
      const result = await client.readResource({ uri: `wizardads://profiles/${profileId}` });
      const first = result.contents[0];
      const text =
        first && 'text' in first && typeof first.text === 'string' ? first.text : undefined;
      if (text === undefined) throw new Error('profile-context resource returned no text');
      return JSON.parse(text) as ProfileContextPayload;
    },
    getSyncStatus: (profileId) =>
      callTool<SyncStatusPayload>('get_sync_status', { profile_id: profileId }),
    getEntityData: (args) =>
      callTool<EntityDataPayload>('get_entity_data', {
        entity: args.entity,
        profile_id: args.profileId,
        date_range: args.dateRange,
        ...(args.compare ? { compare: true } : {}),
      }),
    getFlags: (profileId, asOf) =>
      callTool<FlagsPayload>('get_flags', {
        profile_id: profileId,
        ...(asOf ? { as_of: asOf } : {}),
      }),
    getPacing: (profileId, asOf) =>
      callTool<PacingPayload>('get_pacing', {
        profile_id: profileId,
        ...(asOf ? { as_of: asOf } : {}),
      }),
    close: async () => {
      await client.close();
    },
  };
}
