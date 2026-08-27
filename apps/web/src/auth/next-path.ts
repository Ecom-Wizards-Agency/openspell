/** Keep an auth redirect on this application, or use the caller's fallback. */
export function safeNextPath(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback;
  }
  const parsed = new URL(value, 'http://wizard-ads.local');
  if (parsed.origin !== 'http://wizard-ads.local') return fallback;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
