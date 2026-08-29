import { describe, expect, it } from 'vitest';
import { nextReviewAt } from './next-review-at.js';

describe('nextReviewAt', () => {
  it('selects Monday only and is strictly future at the exact instant', () => {
    const schedule = { weekdays: ['monday'], localTime: '09:15' };
    expect(nextReviewAt({
      after: new Date('2026-08-30T20:00:00.000Z'),
      schedule,
      timeZone: 'Asia/Bangkok',
    }).toISOString()).toBe('2026-08-31T02:15:00.000Z');
    expect(nextReviewAt({
      after: new Date('2026-08-31T02:15:00.000Z'),
      schedule,
      timeZone: 'Asia/Bangkok',
    }).toISOString()).toBe('2026-09-07T02:15:00.000Z');
  });

  it('chooses the earliest of multiple selected weekdays', () => {
    expect(nextReviewAt({
      after: new Date('2026-08-31T10:00:00.000Z'),
      schedule: { weekdays: ['friday', 'wednesday'], localTime: '08:00' },
      timeZone: 'UTC',
    }).toISOString()).toBe('2026-09-02T08:00:00.000Z');
  });

  it('moves a skipped spring-forward wall time to the first valid minute', () => {
    expect(nextReviewAt({
      after: new Date('2026-03-08T05:00:00.000Z'),
      schedule: { weekdays: ['sunday'], localTime: '02:30' },
      timeZone: 'America/New_York',
    }).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('uses only the first repeated fall-back occurrence', () => {
    const schedule = { weekdays: ['sunday'], localTime: '01:30' };
    expect(nextReviewAt({
      after: new Date('2026-11-01T00:00:00.000Z'),
      schedule,
      timeZone: 'America/New_York',
    }).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(nextReviewAt({
      after: new Date('2026-11-01T05:45:00.000Z'),
      schedule,
      timeZone: 'America/New_York',
    }).toISOString()).toBe('2026-11-08T06:30:00.000Z');
  });

  it('rejects duplicate or empty weekday schedules and invalid zones', () => {
    expect(() => nextReviewAt({
      after: new Date(),
      schedule: { weekdays: [], localTime: '08:00' },
      timeZone: 'UTC',
    })).toThrow(/too small|>=1/i);
    expect(() => nextReviewAt({
      after: new Date(),
      schedule: { weekdays: ['monday', 'monday'], localTime: '08:00' },
      timeZone: 'UTC',
    })).toThrow(/unique/i);
    expect(() => nextReviewAt({
      after: new Date(),
      schedule: { weekdays: ['monday'], localTime: '08:00' },
      timeZone: 'not/a-zone',
    })).toThrow(/IANA timezone/);
  });
});
