import { describe, expect, it } from 'vitest';
import { selectRecommendationRun } from './runs.js';

const finished = new Date('2026-08-26T12:00:00Z');

describe('selectRecommendationRun', () => {
  const runs = [
    { id: 'queued', finishedAt: null },
    { id: 'latest-finished', finishedAt: finished },
    { id: 'older-finished', finishedAt: finished },
  ];

  it('prefers the newest finished run over a newer queued run', () => {
    expect(selectRecommendationRun(runs, undefined)?.id).toBe('latest-finished');
  });

  it('honors an explicit valid run, including an in-progress one', () => {
    expect(selectRecommendationRun(runs, 'queued')?.id).toBe('queued');
  });

  it('shows the newest active run only when no run has finished', () => {
    expect(selectRecommendationRun([{ id: 'queued', finishedAt: null }], undefined)?.id).toBe('queued');
  });
});
