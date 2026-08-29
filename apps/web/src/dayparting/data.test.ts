import { describe, expect, it } from 'vitest';
import { deriveCurrentSettlingState } from './data';

describe('dayparting maturity at read time', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');

  it('ages an old stored hour into settled evidence', () => {
    expect(deriveCurrentSettlingState({
      utcHour: '2026-08-27T00:00:00.000Z',
      latestRevisionReceivedAt: null,
      settlingWindowHours: 24,
      now,
    })).toBe('settled');
  });

  it('keeps recent event hours settling and recent revisions revised', () => {
    expect(deriveCurrentSettlingState({
      utcHour: '2026-08-29T00:00:00.000Z',
      latestRevisionReceivedAt: null,
      settlingWindowHours: 24,
      now,
    })).toBe('settling');
    expect(deriveCurrentSettlingState({
      utcHour: '2026-08-20T00:00:00.000Z',
      latestRevisionReceivedAt: '2026-08-29T06:00:00.000Z',
      settlingWindowHours: 24,
      now,
    })).toBe('revised');
  });

  it('settles revisions once their tenant-owned window has elapsed', () => {
    expect(deriveCurrentSettlingState({
      utcHour: '2026-08-20T00:00:00.000Z',
      latestRevisionReceivedAt: '2026-08-27T06:00:00.000Z',
      settlingWindowHours: 24,
      now,
    })).toBe('settled');
  });
});
