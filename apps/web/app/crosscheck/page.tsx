/**
 * `/crosscheck` — the verdict history, per profile.
 *
 * A standalone route on purpose. The dashboard (WP-06) owns the page this
 * eventually becomes a panel on; until it exists, the verdicts still have to be
 * readable by a human who is deciding whether to trust the numbers, and that
 * human should not have to run a CLI. The chip and the tables are rendered from
 * `@wizard-ads/crosscheck-cli/pure`'s view model, so moving them onto the
 * dashboard later is an import, not a rewrite.
 *
 * Server component: it reads the database directly and renders. There is no
 * client-side state here, and no Amazon call — every one of those lives in the
 * worker.
 */
import type { CSSProperties } from 'react';
import { listCrosscheckedProfiles, loadCrosscheckPanel, withDatabase } from '@wizard-ads/crosscheck-cli';
import type { CrosscheckPanelModel } from '@wizard-ads/crosscheck-cli/pure';
import { CrosscheckPanel } from './panel';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ profile?: string }>;
}

export default async function CrosscheckPage({ searchParams }: PageProps) {
  const { profile } = await searchParams;

  const data = await withDatabase(async (handle) => {
    const profiles = await listCrosscheckedProfiles(handle);
    const selected = profile ?? profiles[0]?.profileId ?? null;
    const model: CrosscheckPanelModel | null =
      selected === null ? null : await loadCrosscheckPanel(handle, { profileId: selected });
    return { profiles, selected, model };
  });

  if (data === null) {
    return (
      <main style={main}>
        <h1 style={heading}>Crosscheck</h1>
        <p style={muted}>
          No database is configured. Set <code>DATABASE_URL</code> and reload; the verdicts are
          read, never computed, here.
        </p>
      </main>
    );
  }

  return (
    <main style={main}>
      <h1 style={heading}>Crosscheck</h1>
      <p style={muted}>
        Our synced facts against the incumbent&apos;s export, per day and per campaign-week. The
        in-progress day is excluded and shown: sales restate for 14 days, so judging it would
        raise a false alarm every morning.
      </p>

      {data.profiles.length > 1 ? (
        <nav style={nav}>
          {data.profiles.map((option) => (
            <a
              key={option.profileId}
              href={`/crosscheck?profile=${option.profileId}`}
              style={{
                ...tab,
                fontWeight: option.profileId === data.selected ? 600 : 400,
              }}
            >
              {option.label} <span style={muted}>{option.region}</span>
            </a>
          ))}
        </nav>
      ) : null}

      {data.model === null ? (
        <p style={muted}>Nothing has been cross-checked yet.</p>
      ) : (
        <CrosscheckPanel model={data.model} />
      )}
    </main>
  );
}

const main: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  margin: '0 auto',
  maxWidth: '72rem',
  padding: '2rem 1.5rem',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: '0 0 0.5rem' };
const muted: CSSProperties = { color: '#6b7280', fontSize: '0.875rem' };
const nav: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '0.75rem', margin: '1rem 0' };
const tab: CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: '0.375rem',
  color: 'inherit',
  padding: '0.25rem 0.625rem',
  textDecoration: 'none',
};
