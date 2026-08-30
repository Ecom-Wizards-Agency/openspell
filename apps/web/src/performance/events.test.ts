import { describe, expect, it } from 'vitest';
import { parseBrowserPerformanceEvent } from './events';

const REVISION = 'a'.repeat(40);

const validVital = () => ({
  event: 'openspell.web_vital',
  pathname: '/grid',
  revision: REVISION,
  metric: 'LCP',
  value: 123.45,
  rating: 'good',
  navigation_type: 'navigate',
});

describe('browser performance event boundary', () => {
  it('accepts the exact closed schema and normalizes numeric precision', () => {
    expect(parseBrowserPerformanceEvent({ ...validVital(), value: 123.4567 })).toEqual({
      ...validVital(),
      value: 123.46,
    });
  });

  it('rejects arbitrary paths and every query-bearing pathname', () => {
    expect(parseBrowserPerformanceEvent({ ...validVital(), pathname: '/not-allowlisted' })).toBeNull();
    expect(parseBrowserPerformanceEvent({ ...validVital(), pathname: '/grid?profile=synthetic' })).toBeNull();
  });

  it('rejects identifiers and labels even when the rest of the event is valid', () => {
    expect(parseBrowserPerformanceEvent({ ...validVital(), profile_id: 'synthetic' })).toBeNull();
    expect(parseBrowserPerformanceEvent({ ...validVital(), label: 'synthetic account' })).toBeNull();
    expect(parseBrowserPerformanceEvent({ ...validVital(), user: 'synthetic actor' })).toBeNull();
  });

  it('rejects nonnumeric, nonfinite, negative and unbounded measurements', () => {
    for (const value of ['123', Number.NaN, Number.POSITIVE_INFINITY, -1, 300_001]) {
      expect(parseBrowserPerformanceEvent({ ...validVital(), value })).toBeNull();
    }
  });

  it('accepts route-ready marks without accepting unknown navigation types', () => {
    const event = {
      event: 'openspell.route_ready',
      pathname: '/dashboard',
      revision: REVISION,
      duration_ms: 88,
      navigation_type: 'spa',
    };
    expect(parseBrowserPerformanceEvent(event)).toEqual(event);
    expect(parseBrowserPerformanceEvent({ ...event, navigation_type: 'external' })).toBeNull();
  });
});
