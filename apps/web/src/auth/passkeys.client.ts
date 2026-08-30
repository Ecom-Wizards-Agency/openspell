'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PasskeySummary {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type PasskeyResult =
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string };

export type PasskeyListResult =
  | { status: 'ok'; passkeys: PasskeySummary[] }
  | { status: 'error'; message: string };

/** Browser-only boundary around Supabase's experimental WebAuthn API. */
export interface BrowserPasskeys {
  signIn(): Promise<PasskeyResult>;
  register(): Promise<PasskeyResult>;
  list(): Promise<PasskeyListResult>;
  rename(passkeyId: string, friendlyName: string): Promise<PasskeyResult>;
  remove(passkeyId: string): Promise<PasskeyResult>;
}

export function createPasskeyAdapter(client: SupabaseClient): BrowserPasskeys {
  return {
    async signIn() {
      try {
        const { data, error } = await client.auth.signInWithPasskey();
        return error || !data.session || !data.user
          ? providerError('The passkey was not accepted. Use an email sign-in link instead.')
          : { status: 'ok', message: 'Passkey accepted.' };
      } catch {
        return providerError('Passkey sign-in is unavailable. Use an email sign-in link instead.');
      }
    },

    async register() {
      try {
        const { data, error } = await client.auth.registerPasskey();
        return error || !data
          ? providerError('The passkey could not be added.')
          : { status: 'ok', message: 'Passkey added.' };
      } catch {
        return providerError('Passkey setup is unavailable in this browser.');
      }
    },

    async list() {
      try {
        const { data, error } = await client.auth.passkey.list();
        if (error || !data) return providerError('Passkeys could not be loaded.');
        const passkeys = data.map((item) => ({
          id: item.id,
          name: item.friendly_name ?? null,
          createdAt: item.created_at,
          lastUsedAt: item.last_used_at ?? null,
        }));
        return passkeys.length === data.length
          ? { status: 'ok', passkeys }
          : providerError('Passkeys could not be reconciled.');
      } catch {
        return providerError('Passkeys could not be loaded.');
      }
    },

    async rename(passkeyId, friendlyName) {
      const name = friendlyName.trim();
      if (!passkeyId || name.length === 0 || name.length > 120) {
        return { status: 'error', message: 'Use a passkey name between 1 and 120 characters.' };
      }
      try {
        const ownership = await listedPasskey(client, passkeyId);
        if (ownership === 'unavailable') {
          return providerError('Passkeys could not be reconciled before the change.');
        }
        if (ownership === 'missing') {
          return { status: 'error', message: 'That passkey is no longer available.' };
        }
        const { data, error } = await client.auth.passkey.update({
          passkeyId,
          friendlyName: name,
        });
        return error || !data
          ? providerError('The passkey name could not be changed.')
          : { status: 'ok', message: 'Passkey renamed.' };
      } catch {
        return providerError('The passkey name could not be changed.');
      }
    },

    async remove(passkeyId) {
      if (!passkeyId) return { status: 'error', message: 'That passkey is not valid.' };
      try {
        const ownership = await listedPasskey(client, passkeyId);
        if (ownership === 'unavailable') {
          return providerError('Passkeys could not be reconciled before the change.');
        }
        if (ownership === 'missing') {
          return { status: 'error', message: 'That passkey is no longer available.' };
        }
        const { error } = await client.auth.passkey.delete({ passkeyId });
        return error
          ? providerError('The passkey could not be removed.')
          : { status: 'ok', message: 'Passkey removed.' };
      } catch {
        return providerError('The passkey could not be removed.');
      }
    },
  };
}

async function listedPasskey(
  client: SupabaseClient,
  passkeyId: string,
): Promise<'owned' | 'missing' | 'unavailable'> {
  const { data, error } = await client.auth.passkey.list();
  if (error || !data) return 'unavailable';
  return data.some((item) => item.id === passkeyId) ? 'owned' : 'missing';
}

export function browserPasskeys(): BrowserPasskeys | null {
  if (typeof window === 'undefined') return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createPasskeyAdapter(
    createBrowserClient(url, key, {
      auth: { experimental: { passkey: true } },
    }),
  );
}

function providerError(message: string): { status: 'error'; message: string } {
  return { status: 'error', message };
}
