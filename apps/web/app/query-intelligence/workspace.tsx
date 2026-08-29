import type { ReactNode } from 'react';
import { QUERY_CATEGORY_LABELS } from '@wizard-ads/core';
import type { QueryCategory } from '@wizard-ads/shared';
import type {
  PpcAttributionRow,
  QueryEvidenceRow,
  QueryIntelligenceModel,
} from '../../src/query-intelligence/model';
import styles from './query-intelligence.module.css';

const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const VOCABULARY_KIND_LABELS = {
  own_brand_term: 'Own Brand',
  own_brand_alias: 'Brand alias',
  competitor_brand: 'Competitor brand',
  competitor_asin: 'Competitor ASIN',
  core_term: 'Core term',
  exclusion: 'Exclusion',
} as const;

const ROLE_LABELS = {
  rank: 'Rank',
  discovery: 'Discovery',
  profit: 'Profit',
  shield: 'Shield',
} as const;

function percent(value: number | null): string {
  return value === null ? '—' : PERCENT.format(value);
}

function barWidth(value: number | null): string {
  if (value === null) return '0%';
  return `${Math.min(100, Math.max(0, value * 100)).toFixed(2)}%`;
}

function badgeClass(category: QueryCategory | null): string {
  if (category === 'unreviewed') return 'wa-badge wa-badge--warn';
  if (category === 'excluded') return 'wa-badge wa-badge--bad';
  if (category === 'core' || category === 'own_brand') return 'wa-badge wa-badge--info';
  return 'wa-badge';
}

function currencyFormatter(currencyCode: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 2,
    });
  } catch {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  }
}

function sourceLabel(source: string): string {
  return source === 'amazon_sp_api_brand_analytics'
    ? 'SP-API Brand Analytics · Search Query Performance'
    : source.replaceAll('_', ' ');
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export interface QueryIntelligenceWorkspaceProps {
  model: QueryIntelligenceModel;
  currencyCode: string;
  selectedCategory: QueryCategory | null;
  search: string;
}

export function QueryIntelligenceWorkspace({
  model,
  currencyCode,
  selectedCategory,
  search,
}: QueryIntelligenceWorkspaceProps): ReactNode {
  const money = currencyFormatter(currencyCode);
  const normalizedSearch = search.trim().toLocaleLowerCase('und');
  const visibleQueries = model.queryRows.filter(
    (row) =>
      (selectedCategory === null || row.category === selectedCategory) &&
      (normalizedSearch.length === 0 ||
        row.searchQuery.toLocaleLowerCase('und').includes(normalizedSearch) ||
        row.asin.toLocaleLowerCase('und').includes(normalizedSearch)),
  );
  const visiblePpc = model.ppcRows.filter(
    (row) =>
      (selectedCategory === null || row.category === selectedCategory) &&
      (normalizedSearch.length === 0 ||
        row.searchTerm.toLocaleLowerCase('und').includes(normalizedSearch) ||
        row.campaignId.toLocaleLowerCase('und').includes(normalizedSearch) ||
        row.adGroupId.toLocaleLowerCase('und').includes(normalizedSearch)),
  );
  const queryLimit = 250;
  const ppcLimit = 150;

  return (
    <div className={styles.workspace}>
      <section className="wa-kpis wa-kpis--dense" aria-label="Query intelligence summary">
        <article className="wa-kpi">
          <span className="wa-kpi__label">Unique queries</span>
          <strong className="wa-kpi__value">{INTEGER.format(model.uniqueQueries)}</strong>
          <span className="wa-kpi__delta">Across {INTEGER.format(model.uniqueAsins)} ASINs</span>
        </article>
        <article className="wa-kpi">
          <span className="wa-kpi__label">Addressable core demand</span>
          <strong className="wa-kpi__value">{INTEGER.format(model.addressableDemand)}</strong>
          <span className="wa-kpi__delta">
            Generic Head excluded · raw {INTEGER.format(model.rawDemand)}
          </span>
        </article>
        <article className="wa-kpi">
          <span className="wa-kpi__label">Needs Review</span>
          <strong className="wa-kpi__value">{INTEGER.format(model.needsReview)}</strong>
          <span className="wa-kpi__delta">
            {INTEGER.format(model.pendingVocabulary)} vocabulary suggestions pending
          </span>
        </article>
        <article className="wa-kpi">
          <span className="wa-kpi__label">Negative proposals</span>
          <strong className="wa-kpi__value">{INTEGER.format(model.proposals.length)}</strong>
          <span className="wa-kpi__delta">Ad-group review and export only</span>
        </article>
      </section>

      <section aria-labelledby="intent-title">
        <div className={styles.sectionHead}>
          <div>
            <span className="wa-label">Intent taxonomy</span>
            <h2 id="intent-title" className={styles.sectionTitle}>Six categories, no blended generic bucket</h2>
          </div>
          <span className="wa-badge">Sunday–Saturday evidence</span>
        </div>
        <div className={styles.intentGrid} data-testid="query-category-grid">
          {model.categorySummaries.map((summary) => (
            <article className={styles.intentCard} key={summary.category}>
              <div className={styles.intentHead}>
                <strong>{summary.label}</strong>
                <span>{INTEGER.format(summary.queryCount)} queries</span>
              </div>
              <div className={styles.primaryShare}>
                <span>Weighted purchase share</span>
                <strong>{percent(summary.purchaseShare)}</strong>
                <span className={styles.bar} aria-hidden="true">
                  <span style={{ width: barWidth(summary.purchaseShare) }} />
                </span>
              </div>
              <div className={styles.primaryShare}>
                <span>Weighted click share</span>
                <strong>{percent(summary.clickShare)}</strong>
                <span className={styles.bar} aria-hidden="true">
                  <span style={{ width: barWidth(summary.clickShare) }} />
                </span>
              </div>
              <dl className={styles.intentMeta}>
                <div>
                  <dt>Demand</dt>
                  <dd>{INTEGER.format(summary.searchVolume)}</dd>
                </div>
                <div>
                  <dt>Impression share</dt>
                  <dd>{percent(summary.impressionShare)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
        <p className="wa-banner wa-banner--info">
          Compare each intent with the same intent in another week. Branded capture and generic
          discovery have different shopper origination and are not directly comparable. SQP
          impression share is product presence on page-one results, not share of voice.
        </p>
      </section>

      <section aria-labelledby="query-evidence-title">
        <div className={styles.sectionHead}>
          <div>
            <span className="wa-label">Query × ASIN evidence</span>
            <h2 id="query-evidence-title" className={styles.sectionTitle}>Detailed category stays attached</h2>
          </div>
          <span className="wa-badge">
            Showing {INTEGER.format(Math.min(visibleQueries.length, queryLimit))} of{' '}
            {INTEGER.format(visibleQueries.length)} filtered rows
          </span>
        </div>
        {visibleQueries.length === 0 ? (
          <div className="wa-empty">
            <p className="wa-empty__title">No matching query evidence</p>
            <p className="wa-empty__body">Clear the category or search filter to widen this view.</p>
          </div>
        ) : (
          <QueryTable rows={visibleQueries.slice(0, queryLimit)} />
        )}
      </section>

      <section aria-labelledby="ppc-title">
        <div className={styles.sectionHead}>
          <div>
            <span className="wa-label">PPC join integrity</span>
            <h2 id="ppc-title" className={styles.sectionTitle}>Spend is assigned once—or not assigned</h2>
          </div>
          <span className={model.assertions.ppcSpendConserved ? 'wa-badge wa-badge--good' : 'wa-badge wa-badge--bad'}>
            {model.assertions.ppcInputRows} in · {model.assertions.ppcOutputRows} out
          </span>
        </div>
        <div className={styles.attributionGrid}>
          {model.ppcSummaries.map((summary) => (
            <article className={styles.attributionCard} key={summary.attribution}>
              <span className="wa-label">{summary.label}</span>
              <strong>{money.format(summary.spend)}</strong>
              <small>{INTEGER.format(summary.rows)} PPC rows</small>
            </article>
          ))}
        </div>
        <p className="wa-banner wa-banner--warn">
          Profile-only and ambiguous rows keep their spend at profile level. Wizard Ads never
          duplicates that spend across candidate ASINs, and these rows cannot support an ASIN-level
          action. Current product-ad mirrors are not dated, so historical live PPC remains
          profile-only until an authoritative weekly ad-to-ASIN mapping exists.
        </p>
        {visiblePpc.length === 0 ? (
          <div className="wa-empty">
            <p className="wa-empty__title">No PPC rows for this view</p>
            <p className="wa-empty__body">The SQP evidence remains valid even when PPC did not run.</p>
          </div>
        ) : (
          <PpcTable rows={visiblePpc.slice(0, ppcLimit)} money={money} />
        )}
      </section>

      <div className={styles.reviewGrid}>
        <section className="wa-card" aria-labelledby="vocabulary-title">
          <header className="wa-card__head">
            <div>
              <span className="wa-label">Marketplace vocabulary</span>
              <h2 id="vocabulary-title" className="wa-card__title">Human approval state</h2>
            </div>
            <span className="wa-card__sub">
              {model.approvedVocabulary} approved · {model.pendingVocabulary} pending
            </span>
          </header>
          <div className="wa-card__body wa-card__body--flush">
            {model.vocabulary.length === 0 ? (
              <div className={styles.compactEmpty}>
                No vocabulary has been loaded for this marketplace. Stored SQP categories remain
                visible, but weekly classification suggestions cannot be reviewed here yet.
              </div>
            ) : (
              <div className={styles.innerTableWrap}>
                <table className="wa-table wa-table--dense">
                  <thead>
                    <tr>
                      <th>Term</th>
                      <th>Kind</th>
                      <th>Source</th>
                      <th>Approval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.vocabulary.slice(0, 100).map((entry) => (
                      <tr key={`${entry.kind}:${entry.normalizedValue}`}>
                        <td>{entry.value}</td>
                        <td>{VOCABULARY_KIND_LABELS[entry.kind]}</td>
                        <td>{entry.source.replaceAll('_', ' ')}</td>
                        <td>
                          <span className={entry.approved ? 'wa-badge wa-badge--good' : 'wa-badge wa-badge--warn'}>
                            {entry.approved ? 'Approved' : 'Needs Review'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <section className="wa-card" aria-labelledby="negatives-title">
          <header className="wa-card__head">
            <div>
              <span className="wa-label">Contextual negatives</span>
              <h2 id="negatives-title" className="wa-card__title">Review/export queue</h2>
            </div>
            <span className="wa-card__sub">No Amazon writes</span>
          </header>
          <div className="wa-card__body wa-card__body--flush">
            {model.proposals.length === 0 ? (
              <div className={styles.compactEmpty}>
                No contextual negative proposals are waiting for this marketplace. Core and Generic
                Head terms are never negated merely because of their category.
              </div>
            ) : (
              <div className={styles.innerTableWrap}>
                <table className="wa-table wa-table--dense">
                  <thead>
                    <tr>
                      <th>Search term</th>
                      <th>Route</th>
                      <th>Ad group</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.proposals.slice(0, 100).map((proposal) => (
                      <tr key={proposal.id ?? `${proposal.adGroupId}:${proposal.normalizedQuery}`}>
                        <td>
                          <strong>{proposal.searchTerm}</strong>
                          <small className={styles.cellSub}>
                            {QUERY_CATEGORY_LABELS[proposal.category]} · {proposal.matchType.replace('_', ' ')}
                          </small>
                        </td>
                        <td>{ROLE_LABELS[proposal.sourceGroupRole]}</td>
                        <td>{proposal.adGroupId}</td>
                        <td>
                          <span className={proposal.status === 'proposed' ? 'wa-badge wa-badge--warn' : 'wa-badge'}>
                            {proposal.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className={styles.cardNote}>
              Own Brand remains valid in Shield. Competitor terms remain valid in conquest. Every
              proposal targets an ad group and still requires human review before export.
            </p>
          </div>
        </section>
      </div>

      <section className="wa-card" aria-labelledby="coverage-title">
        <header className="wa-card__head">
          <div>
            <span className="wa-label">Source and coverage</span>
            <h2 id="coverage-title" className="wa-card__title">Weekly promotion evidence</h2>
          </div>
          <span
            className={
              model.promotionReconciled === true
                ? 'wa-badge wa-badge--good'
                : model.promotionReconciled === false
                  ? 'wa-badge wa-badge--bad'
                  : 'wa-badge wa-badge--warn'
            }
          >
            {model.promotionReconciled === true
              ? 'Counts reconciled'
              : model.promotionReconciled === false
                ? 'Count mismatch'
                : 'Provenance unavailable'}
          </span>
        </header>
        <div className="wa-card__body">
          {model.promotionRuns.length === 0 ? (
            <p className={styles.cardCopy}>
              Query facts exist, but no matching promotion ledger is available for this exact week
              and marketplace. Treat the source as unverified until the SP-API promotion workflow
              records its input and canonical counts.
            </p>
          ) : (
            <div className={styles.promotionList}>
              {model.promotionRuns.map((run) => (
                <article key={run.id} className={styles.promotionRow}>
                  <div>
                    <strong>{sourceLabel(run.sourceSystem)}</strong>
                    <span>{formatTimestamp(run.promotedAt)} UTC · {run.requestedAsins.length} ASINs</span>
                  </div>
                  <dl>
                    <div><dt>Source</dt><dd>{INTEGER.format(run.sourceRows)}</dd></div>
                    <div><dt>Parsed</dt><dd>{INTEGER.format(run.parsedRows)}</dd></div>
                    <div><dt>Refused</dt><dd>{INTEGER.format(run.refusedRows)}</dd></div>
                    <div><dt>Canonical</dt><dd>{INTEGER.format(run.canonicalRows)}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          )}
          <p className={styles.assertionLine} data-testid="query-count-assertions">
            SQP rows {model.assertions.sourceFacts} in / {model.assertions.displayedFactRows} shown ·
            PPC rows {model.assertions.ppcInputRows} in / {model.assertions.ppcOutputRows} joined ·
            spend conserved
          </p>
        </div>
      </section>
    </div>
  );
}

function QueryTable({ rows }: { rows: readonly QueryEvidenceRow[] }): ReactNode {
  return (
    <div className="wa-tablewrap">
      <table className="wa-table wa-table--dense">
        <thead>
          <tr>
            <th>Customer query</th>
            <th>Category</th>
            <th>ASIN</th>
            <th data-numeric="true">Demand</th>
            <th data-numeric="true">Purchase share</th>
            <th data-numeric="true">Click share</th>
            <th data-numeric="true">Impression share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.normalizedQuery}:${row.asin}`}>
              <td>
                <strong>{row.searchQuery}</strong>
                <small className={styles.cellSub}>{row.normalizedQuery}</small>
              </td>
              <td><span className={badgeClass(row.category)}>{row.categoryLabel}</span></td>
              <td>{row.asin}</td>
              <td data-numeric="true">{INTEGER.format(row.searchQueryVolume)}</td>
              <td data-numeric="true"><strong>{percent(row.asinPurchaseShare)}</strong></td>
              <td data-numeric="true"><strong>{percent(row.asinClickShare)}</strong></td>
              <td data-numeric="true" className={styles.secondaryMetric}>
                {percent(row.asinImpressionShare)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PpcTable({ rows, money }: { rows: readonly PpcAttributionRow[]; money: Intl.NumberFormat }): ReactNode {
  return (
    <div className="wa-tablewrap">
      <table className="wa-table wa-table--dense">
        <thead>
          <tr>
            <th>Customer search term</th>
            <th>Category</th>
            <th>Join state</th>
            <th>ASIN evidence</th>
            <th>Group</th>
            <th data-numeric="true">Spend</th>
            <th data-numeric="true">Orders</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>{row.searchTerm}</strong>
                <small className={styles.cellSub}>Campaign {row.campaignId} · Ad group {row.adGroupId}</small>
              </td>
              <td><span className={badgeClass(row.category)}>{row.categoryLabel}</span></td>
              <td>
                <span
                  className={
                    row.attribution === 'asin_exact'
                      ? 'wa-badge wa-badge--good'
                      : row.attribution === 'unmatched'
                        ? 'wa-badge'
                        : 'wa-badge wa-badge--warn'
                  }
                >
                  {row.attributionLabel}
                </span>
              </td>
              <td>{row.asin ?? (row.candidateAsins.length > 0 ? row.candidateAsins.join(', ') : '—')}</td>
              <td>{row.groupRole === null ? 'Unassigned' : ROLE_LABELS[row.groupRole]}</td>
              <td data-numeric="true">{money.format(row.spend)}</td>
              <td data-numeric="true">{INTEGER.format(row.orders)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const QUERY_CATEGORY_OPTIONS = Object.entries(QUERY_CATEGORY_LABELS) as Array<[
  QueryCategory,
  string,
]>;
