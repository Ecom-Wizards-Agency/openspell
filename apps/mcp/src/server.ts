/**
 * The MCP server: tools, resources, and the audit wrapper around both.
 *
 * One server instance is built per authenticated request, bound to one org and
 * one key. That is not a performance choice, it is the isolation boundary: the
 * scope cannot be swapped mid-session because there is no session, and no tool
 * takes an org id as an argument, so there is no argument a caller could supply
 * to reach another org's data.
 */
import { randomBytes } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addDays } from '@wizard-ads/core';
import type { DbHandle } from '@wizard-ads/db';
import { writeAuditEntry } from './audit.js';
import { ENTITY_LEVELS, LEVELS } from './catalog.js';
import type { EntityLevel } from './catalog.js';
import { toCsv } from './csv.js';
import {
  GOTO_ROUTES,
  createGotoLink,
  getLatestRecommendations,
  getProfileContext,
  getSyncStatus,
  listProfiles,
  productCoverage,
  resolveProfile,
  runFactQuery,
} from './data.js';
import type { KeyScopeContext, ProfileRecord } from './data.js';
import { buildFlags, buildPacing } from './analysis.js';
import { GatedError, ToolError } from './errors.js';
import { instructionsDocument } from './instructions.js';
import { ALL_METRICS } from './metrics.js';
import { FILTER_OPERATORS } from './sql.js';
import type { DateWindow, FactQuerySpec, FilterCondition, SortSpec } from './sql.js';
import type { McpConfig } from './config.js';

export const SERVER_NAME = 'wizard-ads';
export const SERVER_VERSION = '0.1.0';

export interface ServerContext {
  handle: DbHandle;
  config: McpConfig;
  scope: KeyScopeContext;
  keyId: string;
  orgSlug: string;
}

// ---------------------------------------------------------------------------
// Shared argument shapes
// ---------------------------------------------------------------------------

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .describe("A calendar day in the profile's own timezone");

const dateRangeSchema = z
  .object({ start: IsoDate, end: IsoDate })
  .describe('Inclusive date window. Both days belong to the result.');

const filterSchema = z.object({
  key: z
    .string()
    .describe('Uppercase column name, or ACOS_TO_TARGET / DELTA_PERCENT / DELTA_ABSOLUTE'),
  operator: z.enum(FILTER_OPERATORS),
  values: z.array(z.string()).optional().describe('Always an array, even for one value'),
  metric: z.string().optional().describe('Required by DELTA_PERCENT and DELTA_ABSOLUTE'),
});

const sortSchema = z.object({
  column: z.string().describe('Any selected column, including *_delta_percent'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

const profileIdSchema = z
  .string()
  .min(1)
  .describe('Internal profile id or Amazon profile id. REQUIRED, and actually applied as a filter.');

const entitySchema = z.enum(ENTITY_LEVELS);

const metricsSchema = z
  .array(z.enum(ALL_METRICS as [string, ...string[]]))
  .optional()
  .describe('Defaults to every metric the level carries');

function priorPeriod(window: DateWindow): DateWindow {
  const days = Math.round((Date.parse(window.to) - Date.parse(window.from)) / 86_400_000) + 1;
  return { from: addDays(window.from, -days), to: addDays(window.to, -days) };
}

function toWindow(range: { start: string; end: string }): DateWindow {
  if (range.start > range.end) {
    throw new ToolError('invalid_argument', `date_range.start (${range.start}) is after end (${range.end})`);
  }
  return { from: range.start, to: range.end };
}

const asFilters = (filters?: z.infer<typeof filterSchema>[]): FilterCondition[] | undefined =>
  filters?.map((filter) => ({
    key: filter.key,
    operator: filter.operator,
    ...(filter.values ? { values: filter.values } : {}),
    ...(filter.metric ? { metric: filter.metric } : {}),
  }));

const asSort = (sort?: z.infer<typeof sortSchema>[]): SortSpec[] | undefined =>
  sort?.map((entry) => ({ column: entry.column, direction: entry.direction }));

// ---------------------------------------------------------------------------
// The audit wrapper
// ---------------------------------------------------------------------------

interface ToolOutcome {
  payload: unknown;
  /** What lands in `audit_log.payload.summary`: enough to reconstruct the call. */
  summary: Record<string, unknown>;
  profileId?: string | null;
}

type ToolHandler<Args> = (args: Args) => Promise<ToolOutcome>;

interface McpToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function jsonResult(payload: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Run a tool, write the audit row, and turn a thrown `ToolError` into a result
 * a model can act on.
 *
 * The audit row is written on every path including the failures, and a failure
 * to write it fails the call. A silent audit log is worse than no audit log:
 * WP-13's "the analyst never wrote anything" claim is checked against this
 * table, and a claim resting on a log that drops rows is not a claim.
 */
function audited<Args>(context: ServerContext, tool: string, handler: ToolHandler<Args>) {
  return async (args: Args): Promise<McpToolResult> => {
    const started = Date.now();
    try {
      const outcome = await handler(args);
      await writeAuditEntry(context.handle, {
        orgId: context.scope.orgId,
        keyId: context.keyId,
        tool,
        params: args,
        outcome: 'ok',
        summary: outcome.summary,
        durationMs: Date.now() - started,
        profileId: outcome.profileId ?? null,
      });
      return jsonResult(outcome.payload);
    } catch (error) {
      const gated = error instanceof GatedError;
      const known = error instanceof ToolError;
      const message = known
        ? error.message
        : 'the query could not be completed. This has been logged; nothing was changed.';
      await writeAuditEntry(context.handle, {
        orgId: context.scope.orgId,
        keyId: context.keyId,
        tool,
        params: args,
        outcome: gated ? 'gated' : 'error',
        summary: {
          code: known ? error.code : 'internal',
          message: known ? error.message : String(error instanceof Error ? error.message : error),
        },
        durationMs: Date.now() - started,
      });
      return jsonResult({ error: known ? error.code : 'internal', message }, true);
    }
  };
}

// ---------------------------------------------------------------------------
// Freshness, attached to every data response
// ---------------------------------------------------------------------------

async function freshness(
  context: ServerContext,
  profile: ProfileRecord,
): Promise<{ latestFactDate: string | null; provisional: boolean | null; note: string }> {
  const rows = await context.handle.sql<{ date: string; provisional: boolean }[]>`
    select date::text as date, provisional
      from public.fact_profile_daily
     where org_id = ${context.scope.orgId} and profile_id = ${profile.id}
     order by date desc
     limit 1
  `;
  const row = rows[0];
  return {
    latestFactDate: row?.date ?? null,
    provisional: row?.provisional ?? null,
    note: row
      ? row.provisional
        ? `${row.date} is still attributing and will restate. Anchor on completed days.`
        : `Facts are loaded through ${row.date}.`
      : 'No profile-grain facts are loaded yet. Call get_sync_status before reading anything into an empty result.',
  };
}

const CONVENTIONS = {
  ratios: 'recomputed from summed bases, never averaged',
  deltaPercent: 'a true percent (+12.5 means twelve and a half percent up), never a ratio',
  archived: 'included; entity state is on the row',
  zeroImpressionRows: 'omitted by Amazon, so absence is not zero',
} as const;

// ---------------------------------------------------------------------------
// Server construction
// ---------------------------------------------------------------------------

export function createMcpServer(context: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'wizard-ads: read-only Amazon Advertising analytics for one org. Read the ' +
        'wizardads://instructions resource first, then list_profiles. Every call is audit-logged.',
    },
  );

  registerReadTools(server, context);
  registerWriteStubs(server, context);
  registerResources(server, context);
  return server;
}

function registerReadTools(server: McpServer, context: ServerContext): void {
  const { handle, config, scope } = context;
  const limitSchema = z
    .number()
    .int()
    .min(1)
    .max(config.maxRows)
    .default(100)
    .describe(`Rows to return, at most ${config.maxRows}`);

  server.registerTool(
    'list_profiles',
    {
      title: 'List profiles',
      description:
        'Every advertising profile this key can see, with its market, currency, timezone, ' +
        'target ACOS, goal lens, monthly budget and sync freshness. Start here: never guess a profile id.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    audited(context, 'list_profiles', async () => {
      const profiles = await listProfiles(handle, scope);
      return {
        payload: {
          org: context.orgSlug,
          keyScope: scope.profileIds === null ? 'all profiles in the org' : 'a subset of profiles',
          count: profiles.length,
          profiles,
        },
        summary: { rows: profiles.length },
      };
    }),
  );

  server.registerTool(
    'get_sync_status',
    {
      title: 'Sync status and freshness',
      description:
        'When this profile last synced, the state of every report type, the job queue, and ' +
        'the rows-parsed against rows-loaded count for the latest load. Read this before ' +
        'concluding anything from a number that looks low.',
      inputSchema: { profile_id: profileIdSchema },
      annotations: { readOnlyHint: true },
    },
    audited(context, 'get_sync_status', async ({ profile_id }: { profile_id: string }) => {
      const profile = await resolveProfile(handle, scope, profile_id);
      const status = await getSyncStatus(handle, scope, profile);
      return {
        payload: status,
        summary: { reports: status.reports.length },
        profileId: profile.id,
      };
    }),
  );

  server.registerTool(
    'get_entity_data',
    {
      title: 'Entity metrics for a period',
      description:
        'Period metrics at one entity level for ONE profile, with optional deltas against the ' +
        'preceding period. Ratios are recomputed from summed bases. Rows come from the fact ' +
        'tables, so archived entities keep their spend.',
      inputSchema: {
        entity: entitySchema,
        profile_id: profileIdSchema,
        date_range: dateRangeSchema,
        compare: z
          .union([z.boolean(), dateRangeSchema])
          .optional()
          .describe('true for the immediately preceding equal-length period, or an explicit range'),
        dimensions: z
          .array(z.string())
          .optional()
          .describe("Columns to key rows on. Defaults to the level's natural key."),
        metrics: metricsSchema,
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    audited(
      context,
      'get_entity_data',
      async (args: {
        entity: EntityLevel;
        profile_id: string;
        date_range: { start: string; end: string };
        compare?: boolean | { start: string; end: string };
        dimensions?: string[];
        metrics?: string[];
        filters?: z.infer<typeof filterSchema>[];
        sort?: z.infer<typeof sortSchema>[];
        limit: number;
      }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const window = toWindow(args.date_range);
        const compare =
          args.compare === undefined || args.compare === false
            ? undefined
            : args.compare === true
              ? priorPeriod(window)
              : toWindow(args.compare);

        const spec: FactQuerySpec = {
          level: args.entity,
          orgId: scope.orgId,
          profileId: profile.id,
          window,
          compare,
          grain: 'period',
          dimensions: args.dimensions,
          metrics: args.metrics as FactQuerySpec['metrics'],
          filters: asFilters(args.filters),
          sort: asSort(args.sort),
          limit: args.limit,
          targetAcos: profile.targetAcos,
        };

        const result = await runFactQuery(handle, spec);
        const coverage =
          args.entity === 'product'
            ? await productCoverage(handle, scope.orgId, profile.id, window)
            : undefined;

        return {
          payload: {
            entity: args.entity,
            profile: {
              id: profile.id,
              amazonProfileId: profile.amazonProfileId,
              name: profile.accountName,
              currency: profile.currencyCode,
              timezone: profile.timezone,
              targetAcos: profile.targetAcos,
            },
            window,
            comparisonWindow: compare ?? null,
            conventions: CONVENTIONS,
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            rows: result.rows,
            ...(coverage
              ? {
                  attribution: {
                    ...coverage,
                    note:
                      'Ad groups advertising more than one ASIN are excluded: their spend cannot be ' +
                      'split between ASINs without inventing a number.',
                  },
                }
              : {}),
            freshness: await freshness(context, profile),
          },
          summary: {
            entity: args.entity,
            rows: result.rows.length,
            truncated: result.truncated,
            window,
          },
          profileId: profile.id,
        };
      },
    ),
  );

  server.registerTool(
    'query',
    {
      title: 'Daily rows',
      description:
        'Daily rows for one profile at one entity level: one row per entity per day, filtered ' +
        'and sorted. This is the SELECT half of the pipeline and it does not aggregate. There is ' +
        'no raw SQL: columns and filter keys come from a whitelist. For totals use group_by.',
      inputSchema: {
        entity: entitySchema,
        profile_id: profileIdSchema,
        date_range: dateRangeSchema,
        columns: z
          .array(z.string())
          .optional()
          .describe('Dimension columns to return. Defaults to the natural key plus date.'),
        metrics: metricsSchema,
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    audited(
      context,
      'query',
      async (args: {
        entity: EntityLevel;
        profile_id: string;
        date_range: { start: string; end: string };
        columns?: string[];
        metrics?: string[];
        filters?: z.infer<typeof filterSchema>[];
        sort?: z.infer<typeof sortSchema>[];
        limit: number;
      }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const window = toWindow(args.date_range);
        const result = await runFactQuery(handle, {
          level: args.entity,
          orgId: scope.orgId,
          profileId: profile.id,
          window,
          grain: 'daily',
          dimensions: args.columns,
          metrics: args.metrics as FactQuerySpec['metrics'],
          filters: asFilters(args.filters),
          sort: asSort(args.sort),
          limit: args.limit,
          targetAcos: profile.targetAcos,
        });

        return {
          payload: {
            entity: args.entity,
            grain: 'daily',
            window,
            conventions: CONVENTIONS,
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            rows: result.rows,
            freshness: await freshness(context, profile),
          },
          summary: { entity: args.entity, rows: result.rows.length, truncated: result.truncated },
          profileId: profile.id,
        };
      },
    ),
  );

  server.registerTool(
    'group_by',
    {
      title: 'Grouped aggregates',
      description:
        'Aggregate one entity level by the dimensions you name, with every ratio recomputed ' +
        'from summed numerators and denominators. This is the only aggregation path: an ACOS ' +
        'that is the mean of ACOSes is wrong in a way that looks right.',
      inputSchema: {
        entity: entitySchema,
        profile_id: profileIdSchema,
        date_range: dateRangeSchema,
        group_by: z.array(z.string()).min(1).describe('Dimension columns to group on'),
        metrics: metricsSchema,
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    audited(
      context,
      'group_by',
      async (args: {
        entity: EntityLevel;
        profile_id: string;
        date_range: { start: string; end: string };
        group_by: string[];
        metrics?: string[];
        filters?: z.infer<typeof filterSchema>[];
        sort?: z.infer<typeof sortSchema>[];
        limit: number;
      }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const window = toWindow(args.date_range);
        const result = await runFactQuery(handle, {
          level: args.entity,
          orgId: scope.orgId,
          profileId: profile.id,
          window,
          grain: 'period',
          dimensions: args.group_by,
          metrics: args.metrics as FactQuerySpec['metrics'],
          filters: asFilters(args.filters),
          sort: asSort(args.sort),
          limit: args.limit,
          targetAcos: profile.targetAcos,
        });

        return {
          payload: {
            entity: args.entity,
            groupedBy: args.group_by,
            window,
            conventions: CONVENTIONS,
            columns: result.columns,
            rowCount: result.rows.length,
            truncated: result.truncated,
            rows: result.rows,
            freshness: await freshness(context, profile),
          },
          summary: { entity: args.entity, groupedBy: args.group_by, rows: result.rows.length },
          profileId: profile.id,
        };
      },
    ),
  );

  server.registerTool(
    'download_data',
    {
      title: 'Export a result as CSV',
      description:
        'The same query as get_entity_data or group_by, returned as CSV text. Size-capped: the ' +
        'response says how many rows it wrote against how many it had, so a truncated export is ' +
        'never mistaken for a complete one.',
      inputSchema: {
        entity: entitySchema,
        profile_id: profileIdSchema,
        date_range: dateRangeSchema,
        group_by: z.array(z.string()).optional().describe('Omit for the level default key'),
        metrics: metricsSchema,
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        limit: z.number().int().min(1).max(50_000).default(5_000),
      },
      annotations: { readOnlyHint: true },
    },
    audited(
      context,
      'download_data',
      async (args: {
        entity: EntityLevel;
        profile_id: string;
        date_range: { start: string; end: string };
        group_by?: string[];
        metrics?: string[];
        filters?: z.infer<typeof filterSchema>[];
        sort?: z.infer<typeof sortSchema>[];
        limit: number;
      }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const window = toWindow(args.date_range);
        const result = await runFactQuery(handle, {
          level: args.entity,
          orgId: scope.orgId,
          profileId: profile.id,
          window,
          grain: 'period',
          dimensions: args.group_by,
          metrics: args.metrics as FactQuerySpec['metrics'],
          filters: asFilters(args.filters),
          sort: asSort(args.sort),
          limit: args.limit,
          targetAcos: profile.targetAcos,
        });

        const csv = toCsv(
          result.columns.map((column) => column.name),
          result.rows,
          config.maxDownloadBytes,
        );

        return {
          payload: {
            entity: args.entity,
            window,
            filename: `${args.entity}-${profile.amazonProfileId}-${window.from}-to-${window.to}.csv`,
            rowsWritten: csv.rowsWritten,
            rowsOffered: csv.rowsOffered,
            truncated: csv.truncated || result.truncated,
            bytes: csv.bytes,
            csv: csv.text,
          },
          summary: {
            entity: args.entity,
            rowsWritten: csv.rowsWritten,
            rowsOffered: csv.rowsOffered,
            bytes: csv.bytes,
          },
          profileId: profile.id,
        };
      },
    ),
  );

  server.registerTool(
    'get_recommendations',
    {
      title: 'Latest proposals',
      description:
        "The latest successful recommendation run for a profile, with every proposal's full " +
        'inputs provenance: the RPC, the click count, which level of the confidence hierarchy ' +
        'supplied the CVR, which ceiling bound the result and whether a cap clamped it. ' +
        'v1 proposes; the operator applies through the web app export.',
      inputSchema: {
        profile_id: profileIdSchema,
        status: z
          .enum(['proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded'])
          .optional(),
        reason: z
          .enum(['high_acos', 'high_spend_no_sales', 'low_acos', 'low_visibility', 'flag', 'pacing'])
          .optional(),
        limit: limitSchema,
      },
      annotations: { readOnlyHint: true },
    },
    audited(
      context,
      'get_recommendations',
      async (args: { profile_id: string; status?: string; reason?: string; limit: number }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const run = await getLatestRecommendations(handle, scope, profile, {
          status: args.status,
          reason: args.reason,
          limit: args.limit,
        });

        return {
          payload:
            run === null
              ? {
                  run: null,
                  note:
                    'No successful recommendation run exists for this profile yet. That is a ' +
                    'statement about the engine having run, not about the account being clean.',
                }
              : { run },
          summary: { run: run?.id ?? null, rows: run?.recommendations.length ?? 0 },
          profileId: profile.id,
        };
      },
    ),
  );

  server.registerTool(
    'get_flags',
    {
      title: 'Performance flags',
      description:
        'Goal-aware, severity-tagged flags from the doctrine engine, plus the suppressed list. ' +
        'A suppressed flag is shown, never dropped: an ACOS swing on a Rank campaign is a ' +
        'last-click attribution artifact, and saying so is more useful than hiding it.',
      inputSchema: {
        profile_id: profileIdSchema,
        as_of: IsoDate.optional().describe('Defaults to the latest day with facts'),
      },
      annotations: { readOnlyHint: true },
    },
    audited(context, 'get_flags', async (args: { profile_id: string; as_of?: string }) => {
      const profile = await resolveProfile(handle, scope, args.profile_id);
      const flags = await buildFlags(handle, scope, profile, args.as_of);
      return {
        payload:
          flags ?? {
            asOf: null,
            note: 'No facts are loaded for this profile, so there is nothing to evaluate.',
          },
        summary: { active: flags?.active.length ?? 0, suppressed: flags?.suppressed.length ?? 0 },
        profileId: profile.id,
      };
    }),
  );

  server.registerTool(
    'get_pacing',
    {
      title: 'Month-to-date pacing',
      description:
        'Month-to-date spend against the monthly budget, with the fixed cut order when over ' +
        'pace (waste, then discovery, then profit, and rank last and only on an explicit ' +
        'decision). Returns null pacing, not an invented budget, when none is set.',
      inputSchema: {
        profile_id: profileIdSchema,
        as_of: IsoDate.optional().describe('Defaults to the latest day with facts'),
      },
      annotations: { readOnlyHint: true },
    },
    audited(context, 'get_pacing', async (args: { profile_id: string; as_of?: string }) => {
      const profile = await resolveProfile(handle, scope, args.profile_id);
      const pacing = await buildPacing(handle, scope, profile, args.as_of);
      return {
        payload:
          pacing ?? {
            asOf: null,
            note: 'No facts are loaded for this profile, so month-to-date spend is unknown.',
          },
        summary: { status: pacing?.pacing?.status ?? null, pace: pacing?.pacing?.pace ?? null },
        profileId: profile.id,
      };
    }),
  );

  server.registerTool(
    'create_goto_link',
    {
      title: 'Deep link into the web app',
      description:
        'Mint a link that opens the web app at exactly this filtered view. Use one whenever a ' +
        'result is bigger than about ten rows: hand a human the view, not a wall of numbers. ' +
        'The link carries the lens (entity, filters, date range), so moving the date range ' +
        'still means something.',
      inputSchema: {
        route: z.enum(GOTO_ROUTES),
        profile_id: profileIdSchema,
        state: z
          .record(z.string(), z.unknown())
          .default({})
          .describe('Filter and grid state restored verbatim on open'),
        label: z.string().max(200).optional(),
        expires_in_days: z.number().int().min(1).max(365).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    audited(
      context,
      'create_goto_link',
      async (args: {
        route: (typeof GOTO_ROUTES)[number];
        profile_id: string;
        state: Record<string, unknown>;
        label?: string;
        expires_in_days?: number;
      }) => {
        const profile = await resolveProfile(handle, scope, args.profile_id);
        const expiresAt =
          args.expires_in_days === undefined
            ? null
            : new Date(Date.now() + args.expires_in_days * 86_400_000);

        const link = await createGotoLink(handle, scope, {
          route: args.route,
          state: { ...args.state, profileId: profile.id },
          label: args.label,
          expiresAt,
          webBaseUrl: config.webBaseUrl,
          token: randomBytes(18).toString('base64url'),
        });

        return {
          payload: {
            ...link,
            kind: 'live query',
            note: 'The link restores the lens and re-runs it, so it shows the data as it is when opened.',
          },
          summary: { route: link.route, token: link.token },
          profileId: profile.id,
        };
      },
    ),
  );
}

/**
 * The write surface, present and refusing.
 *
 * A client that cannot see these tools cannot plan around them, and a client
 * that discovers them by trying an undocumented name gets a protocol error
 * instead of a reason. Each one is typed the way its v1.x version will be, and
 * each one logs the attempt.
 */
function registerWriteStubs(server: McpServer, context: ServerContext): void {
  const stubs: { name: string; description: string; inputSchema: z.ZodRawShape }[] = [
    {
      name: 'update_entities',
      description:
        'GATED until v1.x. Will update bids, budgets and states in bulk. v1 is read-only: it ' +
        'proposes and the operator applies, and the write path unlocks only after the ' +
        'crosscheck exit criterion is met on real profiles.',
      inputSchema: {
        profile_id: profileIdSchema,
        entity_type: z.enum(['campaign', 'ad_group', 'keyword', 'target']),
        updates: z.array(z.record(z.string(), z.unknown())),
        note: z.string().describe('Mandatory on every mutating action, including reverts'),
      },
    },
    {
      name: 'create_negatives',
      description: 'GATED until v1.x. Will create negative keywords and product targets from a preview.',
      inputSchema: {
        profile_id: profileIdSchema,
        negatives: z.array(z.record(z.string(), z.unknown())),
        note: z.string(),
      },
    },
    {
      name: 'apply_optimization',
      description: 'GATED until v1.x. Will apply a staged bid batch, snapshot first, revertible by batch.',
      inputSchema: { profile_id: profileIdSchema, batch_id: z.string(), note: z.string() },
    },
    {
      name: 'create_tag',
      description: 'GATED until v1.x. Will create and assign nested tags.',
      inputSchema: { name: z.string(), parent_id: z.string().optional() },
    },
    {
      name: 'set_context',
      description: 'GATED until v1.x. Will store per-profile operating context.',
      inputSchema: { profile_id: profileIdSchema, content: z.string() },
    },
  ];

  for (const stub of stubs) {
    server.registerTool(
      stub.name,
      {
        title: `${stub.name} (gated)`,
        description: stub.description,
        inputSchema: stub.inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      audited(context, stub.name, async () => {
        throw new GatedError(stub.name);
      }),
    );
  }
}

function registerResources(server: McpServer, context: ServerContext): void {
  const { handle, scope } = context;

  server.registerResource(
    'instructions',
    'wizardads://instructions',
    {
      title: 'How to use this server',
      description: 'Pipeline, entity levels, metric conventions, filter grammar, and the traps.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const profiles = await listProfiles(handle, scope);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: instructionsDocument(context.orgSlug, profiles.length),
          },
        ],
      };
    },
  );

  server.registerResource(
    'profile-context',
    new ResourceTemplate('wizardads://profiles/{profileId}', {
      list: async () => {
        const profiles = await listProfiles(handle, scope);
        return {
          resources: profiles.map((profile) => ({
            uri: `wizardads://profiles/${profile.id}`,
            name: profile.accountName ?? `${profile.countryCode} ${profile.amazonProfileId}`,
            description: `${profile.countryCode} · ${profile.currencyCode} · ${
              profile.syncEnabled ? 'syncing' : 'sync disabled'
            }`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Profile context',
      description:
        'Settings, doctrine shape, entity counts, freshness and recent outside changes for one ' +
        'profile. Context arrives with the data it qualifies, so it cannot be forgotten.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables['profileId'];
      const profileId = Array.isArray(raw) ? raw[0] : raw;
      if (!profileId) throw new ToolError('invalid_argument', 'no profile id in the resource URI');
      const profile = await resolveProfile(handle, scope, profileId);
      const profileContext = await getProfileContext(handle, scope, profile);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(profileContext, null, 2),
          },
        ],
      };
    },
  );
}

export const levelDescriptions = (): Record<string, string> =>
  Object.fromEntries(ENTITY_LEVELS.map((level) => [level, LEVELS[level].description]));
