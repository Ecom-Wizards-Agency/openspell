/**
 * Generic external integration connections.
 *
 * Mirrors `20260827140000_integration_connections.sql`. The API credential is
 * deliberately absent from the row shape: `vaultSecretId` is only an opaque
 * pointer, and the custody RPCs are the sole route to the value.
 */
import { jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { connectionStatus, integrationProvider } from './enums.js';
import { authUsers, orgs } from './tenancy.js';

export type IntegrationConfig = Record<string, unknown>;

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    provider: integrationProvider('provider').notNull(),
    label: text('label').notNull(),
    /** Points into Supabase Vault. The credential itself is never a table column. */
    vaultSecretId: uuid('vault_secret_id'),
    config: jsonb('config').$type<IntegrationConfig>().notNull().default({}),
    status: connectionStatus('status').notNull().default('pending'),
    connectedBy: uuid('connected_by').references(() => authUsers.id, { onDelete: 'set null' }),
    connectedAt: ts('connected_at'),
    lastSyncedAt: ts('last_synced_at'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('integration_connections_org_id_provider_label_key').on(
      t.orgId,
      t.provider,
      t.label,
    ),
  ],
);

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
export type NewIntegrationConnection = typeof integrationConnections.$inferInsert;
