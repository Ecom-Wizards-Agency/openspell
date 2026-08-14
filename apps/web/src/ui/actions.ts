'use server';

/**
 * Org switching and sign-out.
 *
 * The active org is a cookie, and it is never trusted on its own: every read
 * path validates it against `org_members` (see `resolveOrgContext`), so this
 * action can write whatever it is given and a value the user has no membership
 * for simply falls back to their first org.
 */
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { ORG_COOKIE } from '../data/orgs';

export async function selectOrg(formData: FormData): Promise<void> {
  const orgId = formData.get('orgId');
  if (typeof orgId !== 'string' || orgId.length === 0) return;
  const store = await cookies();
  store.set(ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath('/', 'layout');
}
