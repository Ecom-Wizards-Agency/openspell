'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseAdminClient, supabaseAdminConfigured } from '../../../src/auth/admin';
import { currentUser } from '../../../src/auth/session';
import { supabaseConfigured, supabaseServerClient } from '../../../src/auth/supabase';
import { ORG_COOKIE } from '../../../src/cookies';
import { requireDatabase } from '../../../src/data/db';
import {
  claimInvitation,
  findInvitationByTokenHash,
  hashInviteToken,
  unclaimInvitation,
} from '../../../src/data/invitations';
import type { InvitationRecord } from '../../../src/data/invitations';
import { addMember } from '../../../src/data/members';

export async function acceptAsExistingUser(token: string): Promise<void> {
  const handle = requireDatabase();
  const invitation = await requireOpenInvitation(handle, token);
  const user = await currentUser();
  if (user === null) redirect(loginFor(token));
  if (user.email === null || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    redirect(inviteError(token, 'This invitation was issued to a different address.'));
  }

  const claimed = await claimInvitation(handle, hashInviteToken(token), user.id);
  if (claimed === null) redirect(invitePath(token));
  try {
    await addMember(handle, {
      orgId: claimed.orgId,
      userId: user.id,
      role: claimed.role,
      invitationId: claimed.id,
    });
  } catch {
    await unclaimInvitation(handle, claimed.orgId, claimed.id, user.id).catch(() => false);
    redirect(inviteError(token, 'This invitation could not be accepted. Please try again.'));
  }

  await selectAcceptedOrg(claimed.orgId);
  redirect('/dashboard');
}

export async function acceptAsNewUser(token: string, formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '');
  if (password.length < 10) {
    redirect(inviteError(token, 'Choose a password with at least 10 characters.'));
  }
  if (!supabaseConfigured() || !supabaseAdminConfigured()) {
    redirect(inviteError(token, 'Account creation is not configured on this instance.'));
  }

  const handle = requireDatabase();
  await requireOpenInvitation(handle, token);
  if ((await currentUser()) !== null) {
    redirect(inviteError(token, 'You are already signed in. Use the signed-in acceptance option.'));
  }

  // Claim before creating the Auth user: only one racing request may create an
  // account for this invitation. accepted_by is filled after Auth assigns id.
  const claimed = await claimInvitation(handle, hashInviteToken(token));
  if (claimed === null) redirect(invitePath(token));

  let created: Awaited<ReturnType<ReturnType<typeof supabaseAdminClient>['auth']['admin']['createUser']>>;
  try {
    created = await supabaseAdminClient().auth.admin.createUser({
      email: claimed.email,
      password,
      email_confirm: true,
    });
  } catch {
    await unclaimInvitation(handle, claimed.orgId, claimed.id).catch(() => false);
    redirect(inviteError(token, 'The account could not be created. Please try again.'));
  }

  if (created.error !== null || created.data.user === null) {
    await unclaimInvitation(handle, claimed.orgId, claimed.id).catch(() => false);
    const exists =
      created.error?.code === 'email_exists' || created.error?.code === 'user_already_exists';
    redirect(
      inviteError(
        token,
        exists
          ? 'Account already exists — sign in, then reopen this link.'
          : 'The account could not be created. Please try again.',
      ),
    );
  }

  const userId = created.data.user.id;
  try {
    await addMember(handle, {
      orgId: claimed.orgId,
      userId,
      role: claimed.role,
      invitationId: claimed.id,
    });
  } catch {
    // The Auth user may now exist. Reopening the claim lets that user sign in
    // with the chosen password and accept through the existing-user path.
    await unclaimInvitation(handle, claimed.orgId, claimed.id).catch(() => false);
    redirect(
      inviteError(
        token,
        'The account exists, but joining the organisation failed. Sign in, then reopen this link.',
      ),
    );
  }

  const supabase = await supabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email: claimed.email, password });
  if (error !== null) redirect('/login?error=sign+in+to+finish&next=%2Fdashboard');

  await selectAcceptedOrg(claimed.orgId);
  redirect('/dashboard');
}

async function requireOpenInvitation(
  handle: ReturnType<typeof requireDatabase>,
  token: string,
): Promise<InvitationRecord> {
  const invitation = await findInvitationByTokenHash(handle, hashInviteToken(token));
  if (invitation === null || invitation.status !== 'pending') redirect(invitePath(token));
  return invitation;
}

async function selectAcceptedOrg(orgId: string): Promise<void> {
  const store = await cookies();
  store.set(ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
}

function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

function inviteError(token: string, message: string): string {
  return `${invitePath(token)}?error=${encodeURIComponent(message)}`;
}

function loginFor(token: string): string {
  return `/login?next=${encodeURIComponent(invitePath(token))}`;
}
