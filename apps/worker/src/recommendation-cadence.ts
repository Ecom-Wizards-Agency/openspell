/** Operational queue cadence; contains no tenant strategy/doctrine values. */
export const RECOMMENDATION_CADENCE = Object.freeze({
  cadence: '7 days',
  lookbackDays: 7,
  delay: '5 hours',
  priority: 50,
} as const);
