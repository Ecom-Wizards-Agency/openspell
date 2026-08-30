/**
 * Who is signed in.
 *
 * One function, `currentUser()`, and every page and route in this work package
 * goes through it. It reads the Supabase Auth cookie and returns a user id, or
 * null.
 *
 * ## The end-to-end seam
 *
 * The Playwright suite has to sign in, and Supabase Auth is a hosted service:
 * a magic link means an inbox, and a Google redirect means Google. So there is
 * one seam, and it is deliberately hard to leave open by accident:
 *
 *  - it is off unless `WIZARD_ADS_E2E_AUTH=1` is set **on the server**;
 *  - it throws on startup if that flag is set with `NODE_ENV=production`;
 *  - it reads a cookie the real flow never issues.
 *
 * A test-only door that cannot be opened in production is better than an
 * untested login, and both are better than a mock so elaborate it stops
 * resembling the thing it stands in for.
 */
import { cookies } from 'next/headers';
import { cache } from 'react';
import {
  E2E_AAL_CURRENT_COOKIE,
  E2E_AAL_NEXT_COOKIE,
  E2E_USER_COOKIE,
  E2E_USER_EMAIL_COOKIE,
} from '../cookies';
import { isAssuranceLevel } from './assurance';
import type { AssuranceLevel, SessionSecurity } from './assurance';
import { supabaseConfigured, supabaseServerClient } from './supabase';

export {
  E2E_AAL_CURRENT_COOKIE,
  E2E_AAL_NEXT_COOKIE,
  E2E_USER_COOKIE,
  E2E_USER_EMAIL_COOKIE,
};

export interface SessionUser {
  id: string;
  email: string | null;
}

/** True when the test-only session cookie is honoured. Refuses production outright. */
export function e2eAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['WIZARD_ADS_E2E_AUTH'] !== '1') return false;
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      'WIZARD_ADS_E2E_AUTH=1 is set in a production build. This is a test-only ' +
        'authentication bypass and must never be enabled on a deployed instance.',
    );
  }
  return true;
}

async function readCurrentUser(): Promise<SessionUser | null> {
  if (e2eAuthEnabled()) {
    const store = await cookies();
    const id = store.get(E2E_USER_COOKIE)?.value;
    const email = store.get(E2E_USER_EMAIL_COOKIE)?.value ?? null;
    if (id) return { id, email };
  }

  if (!supabaseConfigured()) return null;

  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

async function readCurrentSessionSecurity(): Promise<SessionSecurity> {
  if (e2eAuthEnabled()) {
    const store = await cookies();
    const id = store.get(E2E_USER_COOKIE)?.value;
    if (id) {
      const currentValue = store.get(E2E_AAL_CURRENT_COOKIE)?.value ?? 'aal2';
      const nextValue = store.get(E2E_AAL_NEXT_COOKIE)?.value ?? 'aal2';
      if (!isAssuranceLevel(currentValue) || !isAssuranceLevel(nextValue)) {
        return { state: 'unavailable', reason: 'unknown-assurance' };
      }
      return {
        state: 'authenticated',
        user: {
          id,
          email: store.get(E2E_USER_EMAIL_COOKIE)?.value ?? null,
        },
        current: currentValue,
        next: nextValue,
      };
    }
  }

  if (!supabaseConfigured()) return { state: 'anonymous' };

  const supabase = await supabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) return { state: 'unavailable', reason: 'provider-error' };
  if (!userData.user) return { state: 'anonymous' };

  const { data: assurance, error: assuranceError } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || !assurance) {
    return { state: 'unavailable', reason: 'provider-error' };
  }

  const current = normalizeAssurance(assurance.currentLevel, null);
  const next = normalizeAssurance(assurance.nextLevel, current);
  if (current === null || next === null) {
    return { state: 'unavailable', reason: 'unknown-assurance' };
  }
  return {
    state: 'authenticated',
    user: { id: userData.user.id, email: userData.user.email ?? null },
    current,
    next,
  };
}

function normalizeAssurance(value: unknown, fallback: AssuranceLevel | null): AssuranceLevel | null {
  if (value === null || value === undefined) return fallback ?? 'aal1';
  return isAssuranceLevel(value) ? value : null;
}

/**
 * One authoritative Supabase validation per Server Component render.
 *
 * The root layout and the guarded page both need the same user. React's cache
 * is request-scoped, so sharing this result removes a second network round trip
 * without carrying one user's session into another request. Route handlers and
 * tests outside a Server Component render retain the uncached call semantics.
 */
export const currentUser = cache(readCurrentUser);

/** Verified user plus provider-neutral assurance for MFA policy decisions. */
export const currentSessionSecurity = cache(readCurrentSessionSecurity);
