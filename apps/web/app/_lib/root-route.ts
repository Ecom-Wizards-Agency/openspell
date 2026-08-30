/**
 * Preserve an explicit profile when the brand link routes through `/`.
 * Repeated or empty values are ambiguous and are intentionally discarded;
 * `/dashboard` will resolve the remembered, org-scoped active profile instead.
 */
export function rootDashboardPath(profile: string | readonly string[] | undefined): string {
  if (typeof profile !== 'string' || profile.length === 0) return '/dashboard';
  return `/dashboard?${new URLSearchParams({ profile }).toString()}`;
}
