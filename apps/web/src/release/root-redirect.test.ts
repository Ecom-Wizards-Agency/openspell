import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('root entry redirect', () => {
  it('resolves before rendering and leaves dashboard authentication authoritative', async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects).toEqual([
      {
        source: '/',
        destination: '/dashboard',
        permanent: false,
      },
    ]);
  });
});
