/**
 * A URL that is not a screen.
 *
 * Also what `notFound()` renders, which matters more than the typo case: the
 * tag and goto routes answer a resource belonging to another tenant with a 404
 * rather than a 403, on purpose, so this page is part of that answer. It
 * therefore says nothing about whether the thing exists somewhere else.
 */
import type { CSSProperties } from 'react';

export default function NotFound() {
  return (
    <main style={main} data-testid="app-not-found">
      <h1 style={heading}>Not found</h1>
      <p style={body}>
        There is nothing at this address. If you followed a link from inside the product, the
        thing it pointed at is gone or was never yours to see.
      </p>
      <p style={body}>
        <a href="/" style={link}>
          Back to the index
        </a>
      </p>
    </main>
  );
}

const main: CSSProperties = {
  color: '#111827',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  margin: '0 auto',
  maxWidth: '36rem',
  padding: '3rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.75rem' };
const body: CSSProperties = { color: '#6b7280', fontSize: '0.875rem', margin: '0 0 0.75rem' };
const link: CSSProperties = { color: '#111827' };
