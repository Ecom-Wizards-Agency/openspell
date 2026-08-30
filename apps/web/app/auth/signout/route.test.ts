import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/auth/origin', () => ({
  authOrigin: () => 'https://app.example.test',
}));
vi.mock('../../../src/auth/session', () => ({
  E2E_USER_COOKIE: 'synthetic-session',
  e2eAuthEnabled: () => false,
}));
vi.mock('../../../src/auth/supabase', () => ({
  supabaseConfigured: () => false,
  supabaseServerClient: vi.fn(),
}));
vi.mock('../../../src/data/orgs', () => ({ ORG_COOKIE: 'synthetic-org' }));

import { POST } from './route';

describe('/auth/signout', () => {
  it('uses the configured canonical origin even when the request host is hostile', async () => {
    const response = await POST(
      new Request('https://attacker.example/auth/signout?next=%2Fdashboard', { method: 'POST' }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://app.example.test/dashboard');
  });
});
