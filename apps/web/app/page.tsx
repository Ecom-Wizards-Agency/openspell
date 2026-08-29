/**
 * The index. A router, not a screen.
 *
 * Everything real lives one click away: the dashboard says whether to trust the
 * numbers and what moved, the grid is where the work happens, and the
 * crosscheck page is the evidence behind the chip on both.
 */
import type { CSSProperties } from 'react';
import { currentUser } from '../src/auth/session';

export const dynamic = 'force-dynamic';

const ROUTES = [
  {
    href: '/dashboard',
    title: 'Dashboard',
    body: 'Spend, sales, ACOS and CPC against the prior period and the trailing-7 average, with pacing, flags, freshness and the crosscheck verdict.',
  },
  {
    href: '/strategy',
    title: 'Strategy Overview',
    body: 'Stock, pacing, open batches, cooldowns, optimization groups and the next operator decision in one calm view.',
  },
  {
    href: '/optimizer',
    title: 'Campaign Optimizer',
    body: 'Review group-scoped recommendations and their evidence, then export accepted changes without writing to Amazon.',
  },
  {
    href: '/query-intelligence',
    title: 'Query Intelligence',
    body: 'Separate Own Brand, Competitor, Core, Generic Head, Excluded and Needs Review across weekly SQP and PPC evidence.',
  },
  {
    href: '/creative',
    title: 'Creative Performance',
    body: 'Compare Sponsored Brands Video by authoritative Amazon Asset ID, campaign type and placement.',
  },
  {
    href: '/dayparting',
    title: 'Dayparting',
    body: 'Inspect settled hourly Marketing Stream evidence and export proposed schedules. Automatic execution stays off.',
  },
  {
    href: '/grid',
    title: 'Data Grid',
    body: 'Filter, group, reorder and export the complete campaign, target, search-term and placement working set.',
  },
];

export default async function Page() {
  // Every route below this one is per-tenant and signs the visitor in on
  // arrival. Saying so here, once, is cheaper than five redirects that look
  // like the product is broken.
  const user = await currentUser();

  return (
    <main style={main}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem' }}>wizard-ads</h1>
      <p style={{ color: 'var(--wa-text-muted)', margin: '0 0 1.5rem' }}>
        Read-only Amazon advertising operator workspace.
      </p>

      {user === null ? (
        <p style={cta} data-testid="home-signin">
          Every screen below is per-account and needs a session.{' '}
          <a href="/login" style={{ fontWeight: 600 }}>
            Sign in
          </a>{' '}
          to continue. There is no public signup: accounts are created by invitation.
        </p>
      ) : (
        <p style={cta} data-testid="home-signed-in">
          Signed in as {user.email ?? 'your account'}.{' '}
          <a href="/dashboard" style={{ fontWeight: 600 }}>
            Open the dashboard
          </a>
          .
        </p>
      )}

      <ul style={list}>
        {ROUTES.map((route) => (
          <li key={route.href}>
            <a href={route.href} style={card}>
              <strong>{route.title}</strong>
              <span style={{ color: 'var(--wa-text-muted)', fontSize: '0.875rem' }}>{route.body}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

const main: CSSProperties = {
  fontFamily: 'var(--wa-font)',
  margin: '0 auto',
  maxWidth: '48rem',
  padding: '3rem 1.5rem',
};

const list: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

const cta: CSSProperties = {
  border: '1px solid var(--wa-border)',
  borderRadius: '0.375rem',
  fontSize: '0.875rem',
  margin: '0 0 1.5rem',
  padding: '0.75rem 1rem',
};

const card: CSSProperties = {
  border: '1px solid var(--wa-border)',
  borderRadius: '0.375rem',
  color: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '1rem',
  textDecoration: 'none',
};
