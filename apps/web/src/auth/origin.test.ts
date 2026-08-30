import { describe, expect, it } from 'vitest';
import { authOrigin } from './origin';

describe('auth origin', () => {
  it('uses a validated fixed origin', () => {
    expect(authOrigin({ WIZARD_ADS_APP_URL: 'https://app.example.test/' })).toBe(
      'https://app.example.test',
    );
  });

  it('rejects paths and requires configuration in production', () => {
    expect(() => authOrigin({ WIZARD_ADS_APP_URL: 'https://app.example.test/auth' })).toThrow(
      'without a path',
    );
    expect(() => authOrigin({ NODE_ENV: 'production' })).toThrow('required');
    expect(() =>
      authOrigin({ NODE_ENV: 'production', WIZARD_ADS_APP_URL: 'http://app.example.test' }),
    ).toThrow('https');
    expect(authOrigin({ NODE_ENV: 'development', WIZARD_ADS_APP_URL: 'http://localhost:3000' }))
      .toBe('http://localhost:3000');
  });
});
