/** My Real Profit economics.sync handler: Vault -> MCP -> counted daily upsert. */
import { getIntegrationSecret } from '@wizard-ads/db/worker';
import {
  ProductEconomicsLoadCountMismatch,
  upsertProductEconomics,
} from '@wizard-ads/db';
import type {
  DbHandle,
  NewProductEconomics,
  ProductEconomicsLoadCounts,
} from '@wizard-ads/db';
import {
  MrpAuthError,
  MrpClient,
  MrpConfigError,
  MrpParseError,
  MrpProtocolError,
  MrpToolCallError,
  MrpToolNotFoundError,
} from '@wizard-ads/mrp-api';
import type {
  FetchLike,
  MrpClientOptions,
  MrpEconomicsResult,
  MrpProductEconomics,
} from '@wizard-ads/mrp-api';
import type { EconomicsSyncJob } from '@wizard-ads/shared';
import { PermanentJobError } from './worker.js';

export interface MrpConnection {
  id: string;
  config: Record<string, unknown>;
}

export interface MrpEconomicsSyncStore {
  connection(args: { orgId: string; profileId: string }): Promise<MrpConnection | null>;
  secret(connectionId: string): Promise<string | null>;
  load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts>;
  succeeded(args: { orgId: string; connectionId: string; syncedAt: Date }): Promise<void>;
  failed(args: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }): Promise<void>;
}

interface MrpEconomicsClient {
  fetchProductEconomics(): Promise<MrpEconomicsResult>;
}

export interface MrpEconomicsSyncOptions {
  fetch?: FetchLike;
  now?: () => Date;
  clientFactory?: (options: MrpClientOptions) => MrpEconomicsClient;
}

const URL_REQUIRED = 'Enter the My Real Profit MCP URL in this connection\'s config.url.';
const TOKEN_REQUIRED = 'Enter a My Real Profit personal access token in Settings > Integrations.';

function configUrl(config: Record<string, unknown>): string | null {
  const value = config['url'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Pure 1:1 mapper. A missing provider day uses the job's captured UTC day. */
export function mapMrpProductEconomics(
  args: { orgId: string; profileId: string; capturedOn: string; loadedAt: Date },
  products: readonly MrpProductEconomics[],
): NewProductEconomics[] {
  const rows = products.map((product) => ({
    orgId: args.orgId,
    profileId: args.profileId,
    asin: product.asin,
    capturedOn: product.capturedOn ?? args.capturedOn,
    salePrice: product.salePrice,
    cogs: product.cogs,
    fbaFees: product.fbaFees,
    referralFees: product.referralFees,
    otherFees: product.otherFees,
    margin: product.margin,
    ltvRevenue: product.ltvRevenue,
    ltvOrders: product.ltvOrders,
    repeatRate: product.repeatRate,
    currency: product.currency,
    source: 'mrp',
    details: product.details,
    loadedAt: args.loadedAt,
  }));
  if (rows.length !== products.length) {
    throw new Error(`MRP mapped ${rows.length} of ${products.length} product rows`);
  }
  return rows;
}

function operatorFailure(error: unknown): { message: string; permanent: boolean } {
  if (error instanceof MrpAuthError) {
    return {
      message: 'My Real Profit rejected the personal access token. Replace it in Settings > Integrations.',
      permanent: true,
    };
  }
  if (error instanceof MrpToolNotFoundError) {
    return {
      message: 'No My Real Profit product economics tool was found at the configured MCP URL.',
      permanent: true,
    };
  }
  if (
    error instanceof MrpConfigError ||
    error instanceof MrpParseError ||
    error instanceof MrpProtocolError ||
    error instanceof MrpToolCallError
  ) {
    return {
      message: 'My Real Profit returned an unsupported MCP response. Check the URL or contact the provider.',
      permanent: true,
    };
  }
  return {
    message: 'My Real Profit sync failed temporarily. The worker will retry it.',
    permanent: false,
  };
}

/** Provider-independent orchestration seam used by unit tests and the DB-bound factory. */
export function createMrpEconomicsHandler(
  store: MrpEconomicsSyncStore,
  options: MrpEconomicsSyncOptions = {},
): (payload: EconomicsSyncJob) => Promise<Record<string, unknown>> {
  const now = options.now ?? (() => new Date());
  const clientFactory = options.clientFactory ?? ((clientOptions) => new MrpClient(clientOptions));

  return async (payload) => {
    const connection = await store.connection({ orgId: payload.orgId, profileId: payload.profileId });
    if (!connection) {
      throw new PermanentJobError('No active My Real Profit connection is configured for this profile.');
    }

    const failPermanently = async (message: string): Promise<never> => {
      await store.failed({
        orgId: payload.orgId,
        connectionId: connection.id,
        lastError: message,
        disable: true,
      });
      throw new PermanentJobError(message);
    };

    const endpoint = configUrl(connection.config);
    if (!endpoint) return failPermanently(URL_REQUIRED);
    const token = await store.secret(connection.id);
    if (!token?.trim()) return failPermanently(TOKEN_REQUIRED);

    const capturedAt = now();
    try {
      const clientOptions: MrpClientOptions = {
        endpoint,
        token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      };
      const result = await clientFactory(clientOptions).fetchProductEconomics();
      const rows = mapMrpProductEconomics({
        orgId: payload.orgId,
        profileId: payload.profileId,
        capturedOn: utcDate(capturedAt),
        loadedAt: capturedAt,
      }, result.products);
      const counts = await store.load(rows);
      if (counts.offered !== rows.length || counts.written !== rows.length) {
        throw new ProductEconomicsLoadCountMismatch(counts);
      }
      await store.succeeded({
        orgId: payload.orgId,
        connectionId: connection.id,
        syncedAt: capturedAt,
      });
      return {
        provider: 'mrp',
        toolName: result.toolName,
        productsReceived: result.products.length,
        rowsLoaded: counts.written,
        capturedOn: utcDate(capturedAt),
      };
    } catch (error) {
      const failure = operatorFailure(error);
      await store.failed({
        orgId: payload.orgId,
        connectionId: connection.id,
        lastError: failure.message,
        disable: failure.permanent,
      }).catch(() => {});
      if (failure.permanent) throw new PermanentJobError(failure.message);
      throw error;
    }
  };
}

class PostgresMrpEconomicsSyncStore implements MrpEconomicsSyncStore {
  constructor(private readonly handle: DbHandle) {}

  async connection(args: { orgId: string; profileId: string }): Promise<MrpConnection | null> {
    const rows = await this.handle.sql<{ id: string; config: Record<string, unknown> }[]>`
      select id, config
        from public.integration_connections
       where org_id = ${args.orgId}
         and provider = 'mrp'
         and status = 'active'
         and (
           nullif(btrim(config ->> 'profile_id'), '') is null
           or config ->> 'profile_id' = ${args.profileId}
         )
       order by (config ->> 'profile_id' = ${args.profileId}) desc, created_at, id
       limit 1
    `;
    return rows[0] ?? null;
  }

  secret(connectionId: string): Promise<string | null> {
    return getIntegrationSecret(this.handle, connectionId);
  }

  load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts> {
    return upsertProductEconomics(this.handle, rows);
  }

  async succeeded(args: { orgId: string; connectionId: string; syncedAt: Date }): Promise<void> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.integration_connections
         set status = 'active', last_synced_at = ${args.syncedAt}, last_error = null
       where org_id = ${args.orgId} and id = ${args.connectionId} and provider = 'mrp'
      returning id
    `;
    if (rows.length !== 1) throw new Error('MRP connection disappeared before sync completion');
  }

  async failed(args: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }): Promise<void> {
    await this.handle.sql`
      update public.integration_connections
         set status = case when ${args.disable} then 'error'::public.connection_status else status end,
             last_error = ${args.lastError}
       where org_id = ${args.orgId} and id = ${args.connectionId} and provider = 'mrp'
    `;
  }
}

/** Bind the economics handler to the service-role database used by the worker. */
export function createMrpEconomicsSync(
  handle: DbHandle,
  options: MrpEconomicsSyncOptions = {},
): (payload: EconomicsSyncJob) => Promise<Record<string, unknown>> {
  return createMrpEconomicsHandler(new PostgresMrpEconomicsSyncStore(handle), options);
}
