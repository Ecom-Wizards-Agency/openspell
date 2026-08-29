import type { CSSProperties } from 'react';
import { tokens } from '@wizard-ads/ui';

/** Immediate route feedback while the complete, unpaginated grid is loading. */
export default function GridLoading() {
  return (
    <main className="wa-page" aria-busy="true" aria-live="polite">
      <header>
        <p className="wa-kicker">Data Grid</p>
        <h1 className="wa-page-title">Loading the complete result set</h1>
        <p className="wa-page-sub">
          Preparing the selected period, comparison window, and saved operator layout.
        </p>
      </header>
      <section className="wa-card" style={panel} aria-label="Grid loading state">
        <div style={toolbar}>
          <span style={{ ...block, width: '9rem' }} />
          <span style={{ ...block, width: '13rem' }} />
          <span style={{ ...block, marginLeft: 'auto', width: '7rem' }} />
        </div>
        <div style={headerRow}>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} style={{ ...block, width: index === 0 ? '11rem' : '6rem' }} />
          ))}
        </div>
        {Array.from({ length: 8 }, (_, row) => (
          <div key={row} style={dataRow}>
            {Array.from({ length: 6 }, (_, column) => (
              <span
                key={column}
                style={{
                  ...block,
                  opacity: 0.38 + ((row + column) % 3) * 0.12,
                  width: column === 0 ? `${8 + (row % 3) * 1.5}rem` : `${4.5 + ((row + column) % 2)}rem`,
                }}
              />
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}

const panel: CSSProperties = { overflow: 'hidden', padding: 0 };
const toolbar: CSSProperties = {
  alignItems: 'center',
  borderBottom: `1px solid ${tokens.color.border}`,
  display: 'flex',
  gap: tokens.space(2),
  padding: tokens.space(3),
};
const headerRow: CSSProperties = {
  ...toolbar,
  background: tokens.color.surface,
  justifyContent: 'space-between',
};
const dataRow: CSSProperties = {
  ...toolbar,
  justifyContent: 'space-between',
  minHeight: '2.5rem',
};
const block: CSSProperties = {
  background: tokens.color.border,
  borderRadius: tokens.radius.sm,
  display: 'inline-block',
  height: '0.7rem',
};
