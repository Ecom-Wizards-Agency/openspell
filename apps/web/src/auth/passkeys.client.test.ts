import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { browserPasskeys, createPasskeyAdapter } from './passkeys.client';

function client(auth: Record<string, unknown>): SupabaseClient {
  return { auth } as unknown as SupabaseClient;
}

describe('browser passkey adapter', () => {
  it('does not construct a passkey client during server rendering', () => {
    expect(browserPasskeys()).toBeNull();
  });

  it('maps the verified experimental SDK methods into stable app results', async () => {
    const signInWithPasskey = vi.fn().mockResolvedValue({
      data: { session: {}, user: {} },
      error: null,
    });
    const registerPasskey = vi.fn().mockResolvedValue({
      data: { id: 'key-1', created_at: '2026-08-30' },
      error: null,
    });
    const list = vi.fn().mockResolvedValue({
      data: [{ id: 'key-1', friendly_name: 'Laptop', created_at: '2026-08-30' }],
      error: null,
    });
    const update = vi.fn().mockResolvedValue({ data: { id: 'key-1' }, error: null });
    const remove = vi.fn().mockResolvedValue({ data: null, error: null });
    const adapter = createPasskeyAdapter(client({
      signInWithPasskey,
      registerPasskey,
      passkey: { list, update, delete: remove },
    }));

    await expect(adapter.signIn()).resolves.toMatchObject({ status: 'ok' });
    await expect(adapter.register()).resolves.toMatchObject({ status: 'ok' });
    await expect(adapter.list()).resolves.toEqual({
      status: 'ok',
      passkeys: [{
        id: 'key-1',
        name: 'Laptop',
        createdAt: '2026-08-30',
        lastUsedAt: null,
      }],
    });
    await expect(adapter.rename('key-1', 'Work laptop')).resolves.toMatchObject({ status: 'ok' });
    await expect(adapter.remove('key-1')).resolves.toMatchObject({ status: 'ok' });
    expect(list).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledWith({ passkeyId: 'key-1', friendlyName: 'Work laptop' });
    expect(remove).toHaveBeenCalledWith({ passkeyId: 'key-1' });
  });

  it('re-lists ownership and refuses stale identifiers before provider mutation', async () => {
    const update = vi.fn();
    const remove = vi.fn();
    const adapter = createPasskeyAdapter(client({
      passkey: {
        list: vi.fn().mockResolvedValue({ data: [], error: null }),
        update,
        delete: remove,
      },
    }));

    await expect(adapter.rename('missing', 'Work laptop')).resolves.toEqual({
      status: 'error',
      message: 'That passkey is no longer available.',
    });
    await expect(adapter.remove('missing')).resolves.toEqual({
      status: 'error',
      message: 'That passkey is no longer available.',
    });
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps provider details behind a fallback-safe error', async () => {
    const adapter = createPasskeyAdapter(client({
      signInWithPasskey: vi.fn().mockRejectedValue(new Error('provider detail')),
    }));
    await expect(adapter.signIn()).resolves.toEqual({
      status: 'error',
      message: 'Passkey sign-in is unavailable. Use an email sign-in link instead.',
    });
  });
});
