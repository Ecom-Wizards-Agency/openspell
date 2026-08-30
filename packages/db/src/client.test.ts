import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const end = vi.fn(async () => {});
  const sql = Object.assign(vi.fn(), { end });
  return {
    drizzle: vi.fn(() => ({ synthetic: true })),
    end,
    postgres: vi.fn(() => sql),
    sql,
  };
});

vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));

import { createDb } from './client.js';

describe('createDb connection lifecycle options', () => {
  beforeEach(() => {
    mocks.drizzle.mockClear();
    mocks.end.mockClear();
    mocks.postgres.mockClear();
  });

  it('passes the serverless idle timeout to postgres.js and closes the client', async () => {
    const handle = createDb({
      connectionString: 'postgresql://example.test/openspell',
      max: 1,
      idleTimeoutSeconds: 1,
    });

    expect(mocks.postgres).toHaveBeenCalledWith('postgresql://example.test/openspell', {
      connection: {},
      idle_timeout: 1,
      max: 1,
      onnotice: expect.any(Function),
      prepare: false,
    });

    await handle.close();
    expect(mocks.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('keeps the existing pool default when no explicit limit is supplied', () => {
    createDb({ connectionString: 'postgresql://example.test/openspell' });

    expect(mocks.postgres).toHaveBeenCalledWith(
      'postgresql://example.test/openspell',
      expect.objectContaining({ idle_timeout: undefined, max: 5 }),
    );
  });
});
