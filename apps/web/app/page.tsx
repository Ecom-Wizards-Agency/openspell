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
    href: '/grid',
    title: 'Grid',
    body: 'Campaigns, ad groups, targets, search terms and placements. No pagination: the whole set, virtualized, with filters, group-by and CSV export.',
  },
  {
    href: '/recommendations',
    title: 'Recommendations',
    body: 'Engine proposals with the numbers that produced them: current to proposed, the reason, the ceiling that bound it, the strategy it was computed under. Accept, dismiss, export.',
  },
  {
    href: '/ngrams',
    title: 'N-gram explorer',
    body: 'Uni, bi and trigrams over the search-term report, scoped by campaign or tag. Pool the evidence a one-click term cannot carry, then propose negatives.',
  },
  {
    href: '/crosscheck',
    title: 'Crosscheck',
    body: 'Our synced facts against the incumbent’s export, per day and per campaign-week.',
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
        In-house Amazon Advertising tool.
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
