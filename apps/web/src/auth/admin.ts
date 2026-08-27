/**
 * The one service-role Supabase client in the web tier.
 *
 * It exists solely for invite acceptance to create an already-confirmed Auth
 * user. Application data still goes through the direct Postgres handle, and
 * session cookies still go through the anon server client in `supabase.ts`.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { required } from '../env';

export function supabaseAdminClient(): SupabaseClient {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

/** Both values are required; the service key without its project URL is inert. */
export function supabaseAdminConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['NEXT_PUBLIC_SUPABASE_URL'] && env['SUPABASE_SERVICE_ROLE_KEY']);
}
