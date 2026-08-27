/** Member administration, invitation lifecycle, and the e2e identity seam. */
import { createDb } from '@wizard-ads/db';
import { expect, test } from '@playwright/test';
import { ORG_COOKIE } from '../src/cookies';
import { createInvitation } from '../src/data/invitations';
import { signIn } from './support/auth';
import { BASE_URL, EMAILS, USERS, readState } from './support/fixture';

test.describe.configure({ mode: 'serial' });

let outsiderInviteUrl = '';

test('viewer and analyst see a refusal and stale controls cannot bypass the action gate', async ({
  page,
}) => {
  for (const role of ['viewer', 'analyst'] as const) {
    await signIn(page, role);
    await page.goto('/settings/members');
    await expect(page.getByTestId('members-forbidden')).toBeVisible();
    await expect(page.getByTestId('create-invite')).toHaveCount(0);
    await expect(page.getByTestId('member-role')).toHaveCount(0);
    await expect(page.getByTestId('remove-member')).toHaveCount(0);
    await expect(page.getByTestId('revoke-invite')).toHaveCount(0);

    // Load a real action while authorised, then replace only the session
    // cookies. The hydrated admin controls remain in the DOM, which models a
    // replayed/stale client without inventing a test-only mutation endpoint.
    await signIn(page, 'admin');
    await page.goto('/settings/members');
    const attempted = `bypass-${role}@example.test`;
    await page.getByLabel('Email').fill(attempted);
    await signIn(page, role);
    await page.getByTestId('create-invite').click();
    await expect(page.getByTestId('invite-error')).toHaveText(
      'Only admins and owners can manage members.',
    );

    await signIn(page, 'admin');
    await page.goto('/settings/members');
    await expect(page.getByTestId('invite-row').filter({ hasText: attempted })).toHaveCount(0);
  }
});

test('admin creates shown-once invitations and revokes the second one', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/settings/members');

  await expect(page.getByRole('link', { name: 'Members' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: 'Account' })).toBeVisible();

  await page.getByLabel('Email').fill(EMAILS.outsider);
  await page.getByLabel('Role', { exact: true }).selectOption('viewer');
  await page.getByTestId('create-invite').click();
  const firstUrl = page.getByTestId('invite-url');
  await expect(firstUrl).toBeVisible();
  outsiderInviteUrl = (await firstUrl.textContent())?.trim() ?? '';
  expect(outsiderInviteUrl.startsWith(`${BASE_URL}/invite/`)).toBe(true);
  await expect(page.getByTestId('invite-url')).toHaveCount(1);
  await expect(page.getByTestId('invite-row').filter({ hasText: EMAILS.outsider })).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('invite-url')).toHaveCount(0);
  await expect(page.getByTestId('invite-row').filter({ hasText: EMAILS.outsider })).toHaveCount(1);

  const revokedEmail = 'revoked@example.test';
  await page.getByLabel('Email').fill(revokedEmail);
  await page.getByTestId('create-invite').click();
  const revokedUrl = (await page.getByTestId('invite-url').textContent())?.trim() ?? '';
  const revokedRow = page.getByTestId('invite-row').filter({ hasText: revokedEmail });
  await expect(revokedRow).toHaveCount(1);
  await revokedRow.getByTestId('revoke-invite').click();
  await expect(revokedRow).toHaveCount(0);

  await page.goto(revokedUrl);
  await expect(page.getByText('This invitation is no longer open.')).toBeVisible();
});

test('an existing fixture user accepts and the accepted org becomes active', async ({ page }) => {
  expect(outsiderInviteUrl).toContain('/invite/');
  await signIn(page, 'outsider');
  await page.goto(outsiderInviteUrl);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  const state = await readState();
  const activeOrg = (await page.context().cookies()).find((cookie) => cookie.name === ORG_COOKIE);
  expect(activeOrg?.value).toBe(state.orgId);

  await signIn(page, 'admin');
  await page.goto('/settings/members');
  await expect(page.getByTestId('member-row').filter({ hasText: EMAILS.outsider })).toHaveCount(1);
});

test('an expired invitation renders the expired outcome', async ({ page }) => {
  const state = await readState();
  const handle = createDb({ connectionString: state.connectionString, max: 1 });
  let token: string | undefined;
  try {
    const issued = await createInvitation(handle, {
      orgId: state.orgId,
      email: 'expired@example.test',
      role: 'analyst',
      invitedBy: USERS.admin,
    });
    token = issued.token;
    const rows = await handle.sql<{ id: string }[]>`
      update public.org_invitations
         set expires_at = now() - interval '1 minute'
       where id = ${issued.invitation.id}
      returning id
    `;
    expect(rows).toHaveLength(1);
  } finally {
    await handle.close();
  }

  if (!token) throw new Error('The expired invitation token was not seeded.');
  await page.goto(`${BASE_URL}/invite/${token}`);
  await expect(page.getByText('This invitation has expired.')).toBeVisible();
});

test('the sole owner has no controls and replayed actions still refuse', async ({ page }) => {
  const state = await readState();
  await signIn(page, 'outsider');
  await page.context().addCookies([
    { name: ORG_COOKIE, value: state.otherOrgId, url: BASE_URL, sameSite: 'Lax' },
  ]);
  await page.goto('/settings/members');

  const ownerRow = page.getByTestId('member-row').filter({ hasText: EMAILS.outsider });
  await expect(ownerRow.getByTestId('member-role-locked')).toContainText('final owner');
  await expect(ownerRow.getByTestId('member-role')).toHaveCount(0);
  await expect(ownerRow.getByTestId('remove-member')).toHaveCount(0);

  // Capture a genuine role action on the main org, then replay it with the
  // outsider's session and sole-owner org selected.
  await signIn(page, 'admin');
  await page.context().addCookies([
    { name: ORG_COOKIE, value: state.orgId, url: BASE_URL, sameSite: 'Lax' },
  ]);
  await page.goto('/settings/members');
  const roleForm = page.getByTestId('member-role').first().locator('xpath=..');
  await roleForm.locator('input[name="userId"]').evaluate((input, userId) => {
    (input as HTMLInputElement).value = userId;
  }, USERS.outsider);
  await roleForm.getByTestId('member-role').selectOption('admin');
  await signIn(page, 'outsider');
  await page.context().addCookies([
    { name: ORG_COOKIE, value: state.otherOrgId, url: BASE_URL, sameSite: 'Lax' },
  ]);
  await roleForm.getByRole('button', { name: 'Save role' }).click();

  // Repeat the replay against the remove action. This request is also the
  // acting user's own id, so the action's self-removal rule refuses it before
  // the SQL final-owner invariant needs to.
  await signIn(page, 'admin');
  await page.context().addCookies([
    { name: ORG_COOKIE, value: state.orgId, url: BASE_URL, sameSite: 'Lax' },
  ]);
  await page.goto('/settings/members');
  const removeForm = page.getByTestId('remove-member').first().locator('xpath=..');
  await removeForm.locator('input[name="userId"]').evaluate((input, userId) => {
    (input as HTMLInputElement).value = userId;
  }, USERS.outsider);
  await signIn(page, 'outsider');
  await page.context().addCookies([
    { name: ORG_COOKIE, value: state.otherOrgId, url: BASE_URL, sameSite: 'Lax' },
  ]);
  await removeForm.getByTestId('remove-member').click();

  const handle = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const rows = await handle.sql<{ role: string }[]>`
      select role::text as role from public.org_members
       where org_id = ${state.otherOrgId} and user_id = ${USERS.outsider}
    `;
    expect(rows).toEqual([{ role: 'owner' }]);
  } finally {
    await handle.close();
  }
});
