import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../supabase/migrations/', import.meta.url),
);

const lockSensitiveMigrations = [
  '20260830170000_marketing_stream_correctness.sql',
  '20260830180000_optimization_weekday_schedules.sql',
  '20260831100000_unified_reporting_dual_run.sql',
  '20260901000000_contextual_negative_review_exports.sql',
  '20260901010000_authenticated_relation_privilege_hardening.sql',
] as const;

const DDL_SERIALIZATION_BOUNDARY =
  '20260901010000_authenticated_relation_privilege_hardening.sql';

function topLevelSql(source: string): string | undefined {
  let output = '';

  for (let index = 0; index < source.length; ) {
    if (source.startsWith('--', index)) {
      const newline = source.indexOf('\n', index + 2);
      if (newline === -1) return output;
      output += '\n';
      index = newline + 1;
      continue;
    }

    if (source.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) return undefined;
      output += ' ';
      continue;
    }

    const dollarTag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
    if (dollarTag) {
      const closing = source.indexOf(dollarTag, index + dollarTag.length);
      if (closing === -1) return undefined;
      output += ' ';
      index = closing + dollarTag.length;
      continue;
    }

    const quote = source[index];
    if (quote === "'" || quote === '"') {
      output += quote;
      index += 1;
      while (index < source.length) {
        output += source[index];
        if (source[index] === quote) {
          if (source[index + 1] === quote) {
            output += source[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      if (!output.endsWith(quote)) return undefined;
      continue;
    }

    output += source[index];
    index += 1;
  }

  return output;
}

function hasBoundedLockEnvelope(source: string): boolean {
  if (/^\s*--[^\n]*\bpg-delta:\s*transaction\s*=\s*false\b/im.test(source)) return false;

  const executable = topLevelSql(source);
  if (executable === undefined) return false;

  const lockTimeoutReferences = executable.match(/\block_timeout\b/gi) ?? [];
  const transactionControl =
    /(?:^|;)\s*(?:begin|start\s+transaction|commit|end|abort|rollback|prepare\s+transaction)\b/i;
  const pipelineIncompatible =
    /\b(?:create\s+(?:unique\s+)?index|drop\s+index|reindex\b[^;]*)\s+concurrently\b|\b(?:vacuum|alter\s+system|cluster|create\s+(?:database|tablespace|subscription)|drop\s+(?:database|tablespace|subscription)|discard\s+all)\b/i;

  return (
    executable.trimStart().startsWith("set local lock_timeout = '5s';") &&
    lockTimeoutReferences.length === 1 &&
    !/\breset\s+all\b/i.test(executable) &&
    !/\bset_config\s*\(/i.test(executable) &&
    !/^\s*do\b/im.test(executable) &&
    !transactionControl.test(executable) &&
    !pipelineIncompatible.test(executable)
  );
}

function hasDdlSerializationEnvelope(source: string): boolean {
  const executable = topLevelSql(source);
  if (executable === undefined) return false;

  return /^\s*set local lock_timeout = '5s';\s*select\s+pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*'wizard-ads:schema-ddl:v1'\s*,\s*0\s*\)\s*\)\s*;/i.test(
    executable,
  );
}

describe('hosted migration lock safety', () => {
  it.each(lockSensitiveMigrations)('%s fails closed on lock contention', async (file) => {
    const source = await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8');

    expect(hasBoundedLockEnvelope(source)).toBe(true);
  });

  it('serializes WP-186 and every later repository migration on one DDL lock', async () => {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql') && file >= DDL_SERIALIZATION_BOUNDARY)
      .sort();

    expect(files).not.toEqual([]);
    for (const file of files) {
      const source = await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8');
      expect(hasBoundedLockEnvelope(source), file).toBe(true);
      expect(hasDdlSerializationEnvelope(source), file).toBe(true);
    }
  });

  it.each([
    `-- pg-delta: transaction=false
set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);
create table public.fixture (id integer);`,
    `set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);
commit;
create table public.fixture (id integer);`,
  ])('rejects a serialization prefix whose transaction envelope can escape', (source) => {
    expect(hasDdlSerializationEnvelope(source)).toBe(true);
    expect(hasBoundedLockEnvelope(source)).toBe(false);
  });

  it.each([
    "grant select on public.fixture to authenticated;\nset local lock_timeout = '5s';",
    "comment on table public.fixture is 'fixture';\nset local lock_timeout = '5s';",
    "  create index fixture_idx on public.fixture (id);\nset local lock_timeout = '5s';",
    "set local lock_timeout = '5s';\nreset lock_timeout;\ncreate index fixture_idx on public.fixture (id);",
    "-- set local lock_timeout = '5s';\ncreate index fixture_idx on public.fixture (id);",
    "-- pg-delta: transaction=false\nset local lock_timeout = '5s';\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\nbegin;\ncreate table public.fixture (id integer);\ncommit;",
    "set local lock_timeout = '5s';\nend;\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\nabort;\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\nprepare transaction 'fixture';\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\ncreate index concurrently fixture_idx on public.fixture (id);",
    "set local lock_timeout = '5s';\ncluster public.fixture using fixture_idx;",
    "set local lock_timeout = '5s';\nreset all;\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\nset local lock_timeout = '0';\ncreate table public.fixture (id integer);",
    "set local lock_timeout = '5s';\nselect set_config('lock_timeout', '0', true);",
  ])('rejects an incomplete lock envelope', (source) => {
    expect(hasBoundedLockEnvelope(source)).toBe(false);
  });

  it('ignores transaction-like text inside stored PL/pgSQL bodies', () => {
    const source = `
      -- migration header
      set local lock_timeout = '5s';
      create function app.fixture()
      returns void language plpgsql as $body$
      begin
        perform set_config('lock_timeout', '0', true);
        reset all;
      end;
      $body$;
    `;

    expect(hasBoundedLockEnvelope(source)).toBe(true);
  });
});
