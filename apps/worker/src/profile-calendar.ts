/** Return the current calendar day in an advertising profile's timezone. */
export function profileToday(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
