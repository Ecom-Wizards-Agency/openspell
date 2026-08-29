import { describe, expect, it } from 'vitest';
import { DAYPARTING_EXPORT_EFFECT, parseDaypartingExportFormat } from './route';

describe('dayparting export contract', () => {
  it('allows only file generation and declares the Amazon-safe effect', () => {
    expect(DAYPARTING_EXPORT_EFFECT).toBe('export-only');
    expect(parseDaypartingExportFormat(null)).toBe('csv');
    expect(parseDaypartingExportFormat('csv')).toBe('csv');
    expect(parseDaypartingExportFormat('json')).toBe('json');
  });

  it.each(['apply', 'push', 'amazon', 'xlsx'])('rejects unsupported %s output', (format) => {
    expect(() => parseDaypartingExportFormat(format)).toThrow('format must be csv or json');
  });
});
