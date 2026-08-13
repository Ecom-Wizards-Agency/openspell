/**
 * Partition automation, from TypeScript.
 *
 * These wrap the SQL functions so a backfill can open the months it is about to
 * write into before it writes them (there is no default partition: an insert
 * into a month nobody created fails, loudly, by design).
 */
import type { DbHandle } from '../client.js';

export interface PartitionAction {
  tableName: string;
  partitionName: string;
  month: string;
  created: boolean;
}

/**
 * Create the monthly partitions covering `[from, from + months]` on every
 * managed fact table. Idempotent: existing partitions come back with
 * `created: false`.
 */
export async function ensureFactPartitions(
  handle: DbHandle,
  from: Date | string = new Date(),
  months = 2,
): Promise<PartitionAction[]> {
  const rows = await handle.sql<
    { table_name: string; partition_name: string; month: string; created: boolean }[]
  >`
    select table_name, partition_name, month::text, created
    from app.ensure_fact_partitions(${asDate(from)}::date, ${months})
  `;
  return rows.map((row) => ({
    tableName: row.table_name,
    partitionName: row.partition_name,
    month: row.month,
    created: row.created,
  }));
}

export interface RetentionAction {
  tableName: string;
  partitionName: string;
  month: string;
  rowsRolledUp: number;
  dropped: boolean;
}

/**
 * Roll up and drop every partition past its table's retention.
 *
 * `dryRun` reports exactly what a real run would remove and touches nothing,
 * which is the only responsible way to introduce a function that drops data.
 */
export async function dropExpiredFactPartitions(
  handle: DbHandle,
  today: Date | string = new Date(),
  dryRun = false,
): Promise<RetentionAction[]> {
  const rows = await handle.sql<
    {
      table_name: string;
      partition_name: string;
      month: string;
      rows_rolled_up: string | number;
      dropped: boolean;
    }[]
  >`
    select table_name, partition_name, month::text, rows_rolled_up, dropped
    from app.drop_expired_fact_partitions(${asDate(today)}::date, ${dryRun})
  `;
  return rows.map((row) => ({
    tableName: row.table_name,
    partitionName: row.partition_name,
    month: row.month,
    rowsRolledUp: Number(row.rows_rolled_up),
    dropped: row.dropped,
  }));
}

export interface PartitionStatusRow {
  tableName: string;
  partitionName: string;
  month: string | null;
  bytes: number;
}

/** Every attached partition of every managed fact table. */
export async function listFactPartitions(handle: DbHandle): Promise<PartitionStatusRow[]> {
  const rows = await handle.sql<
    { table_name: string; partition_name: string; month: string | null; bytes: string | number }[]
  >`
    select table_name, partition_name, month::text, bytes
    from app.fact_partition_status
    order by table_name, month
  `;
  return rows.map((row) => ({
    tableName: row.table_name,
    partitionName: row.partition_name,
    month: row.month,
    bytes: Number(row.bytes),
  }));
}

function asDate(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}
