import { NextResponse } from 'next/server';
import { decideAssurance, requiredAssurance } from '../../../src/auth/assurance';
import { authFeatureConfig } from '../../../src/auth/config';
import { assuranceDestination } from '../../../src/auth/continuation';
import { safeNextPath } from '../../../src/auth/next-path';
import { authOrigin } from '../../../src/auth/origin';
import { currentSessionSecurity, currentUser } from '../../../src/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The single post-primary checkpoint for password, email, OAuth, and passkeys. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = authOrigin();
  const next = safeNextPath(url.searchParams.get('next'), '/dashboard');
  const config = authFeatureConfig();

  if (config.totpPolicy === 'off' || config.totpPolicy === 'enrollment-only') {
    const user = await currentUser();
    const destination = user === null
      ? `/login?${new URLSearchParams({ next }).toString()}`
      : next;
    return NextResponse.redirect(new URL(destination, origin));
  }

  const decision = decideAssurance({
    session: await currentSessionSecurity(),
    requirement: requiredAssurance({ config, surface: 'operator' }),
    returnTo: next,
  });
  const destination = decision.kind === 'allow' ? next : assuranceDestination(decision);
  return NextResponse.redirect(new URL(destination, origin));
}
