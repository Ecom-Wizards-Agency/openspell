/** Server-heavy routes must load only when the operator asks for them. */
export const EXPENSIVE_ROUTE_PATHNAMES = new Set([
  '/creative',
  '/dashboard',
  '/dayparting',
  '/grid',
  '/optimizer',
  '/optimizer/groups',
  '/query-intelligence',
  '/recommendations',
  '/strategy',
  '/time-machine',
]);

export function shouldPrefetchRoute(pathname: string): boolean {
  return !EXPENSIVE_ROUTE_PATHNAMES.has(pathname);
}
