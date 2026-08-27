/**
 * The page context attached to a submission.
 *
 * A bug report is worth roughly twice as much when it says where it happened,
 * and roughly nothing when the reporter has to remember to say so. This module
 * turns whatever the widget captured into a small, bounded, JSON-safe document
 * — and it is pure, so what the user is shown before submitting and what the
 * server stores are the same function of the same input rather than two
 * hand-written objects that drift.
 *
 * Nothing here trusts its input: the route comes from the browser and lands in
 * a jsonb column that an admin reads, so it is length-capped and constrained to
 * an internal path.
 */

export type FeedbackActorType = 'user' | 'mcp';

export interface PageContextInput {
  route?: string | null;
  profileId?: string | null;
  appVersion?: string | null;
  actorType?: FeedbackActorType;
}

export interface PageContext {
  route: string | null;
  profileId: string | null;
  appVersion: string | null;
  actorType: FeedbackActorType;
}

const MAX_ROUTE = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Keep an application path, drop anything else.
 *
 * An absolute URL, a protocol-relative one or a backslash path could all send a
 * later reader somewhere off-site from an admin screen, so they are dropped
 * rather than sanitised into something that looks trustworthy.
 */
export function normalizeRoute(route: string | null | undefined): string | null {
  if (typeof route !== 'string') return null;
  const trimmed = route.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) return null;
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32)) return null;
  return trimmed.slice(0, MAX_ROUTE);
}

/** Recover the selected profile from the route captured by the feedback entry. */
export function profileIdFromRoute(route: string | null | undefined): string | null {
  const normalized = normalizeRoute(route);
  if (normalized === null) return null;
  const candidate = new URL(normalized, 'https://app.invalid').searchParams.get('profile');
  return candidate !== null && UUID.test(candidate) ? candidate : null;
}

export function pageContext(input: PageContextInput): PageContext {
  return {
    route: normalizeRoute(input.route),
    profileId: typeof input.profileId === 'string' && UUID.test(input.profileId)
      ? input.profileId
      : null,
    appVersion:
      typeof input.appVersion === 'string' && input.appVersion.trim()
        ? input.appVersion.trim().slice(0, 64)
        : null,
    actorType: input.actorType === 'mcp' ? 'mcp' : 'user',
  };
}

/** What the submit form shows the user before they press the button. */
export function describePageContext(context: PageContext): string {
  const parts = [
    `page: ${context.route ?? 'unknown'}`,
    `profile: ${context.profileId ?? 'none selected'}`,
    `version: ${context.appVersion ?? 'unknown'}`,
  ];
  return parts.join(' · ');
}
