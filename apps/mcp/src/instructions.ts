/**
 * The bootstrap document, served as `wizardads://instructions`.
 *
 * It exists because half of what makes an ads number wrong is not in the data
 * and not in the schema: zero-impression rows are absent rather than zero,
 * same-day sales are still attributing, ratios must never be averaged, and a
 * profile id that is not actually applied as a predicate is the single bug this
 * server was built not to repeat. A client that reads this first asks better
 * questions; a client that does not still gets the same guards, because every
 * one of them is enforced in code as well as stated here.
 */
import { ENTITY_LEVELS, LEVELS } from './catalog.js';
import { ALL_METRICS, DERIVED_METRICS } from './metrics.js';
import { FILTER_OPERATORS } from './sql.js';

export function instructionsDocument(orgSlug: string, profileCount: number): string {
  const levels = ENTITY_LEVELS.map((level) => `- \`${level}\` — ${LEVELS[level].description}`).join('\n');
  const ratios = Object.entries(DERIVED_METRICS)
    .map(([name, descriptor]) => `- \`${name}\` = ${descriptor.description}`)
    .join('\n');

  return `# wizard-ads MCP — read-only

You are connected to **${orgSlug}** with a read-only key covering ${profileCount} profile${
    profileCount === 1 ? '' : 's'
  }.
Every call you make is written to the audit log with its parameters. Nothing you can call
changes an Amazon account or wizard-ads product data. The production catalog contains
analytical reads only.

## The pipeline

    FETCH    list_profiles -> get_entity_data          what the numbers are
    REFINE   query / group_by                          slice them
    EXPORT   download_data                             take them away as CSV
    EXPLAIN  get_flags / get_pacing / get_recommendations

Start with \`list_profiles\`. Never guess a profile id. \`profile_id\` is required on every
profile-scoped tool and is applied as a predicate on the fact scan, so a result set contains
that profile and nothing else.

## Entity levels

${levels}

## Metrics

Base metrics are summed: ${['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'].join(', ')}.
Ratios are **recomputed from summed bases**, never averaged:

${ratios}

Every metric name usable in \`metrics\`, \`sort\` or a filter: ${ALL_METRICS.join(', ')}.

Do not ask for a GROUP BY in \`query\`. \`query\` returns daily rows; \`group_by\` aggregates and
recalculates the ratios correctly. An ACOS that is the mean of ACOSes is wrong in a way that
looks right.

## Comparisons

Pass \`compare: true\` to \`get_entity_data\` and every metric gains three columns:
\`<metric>_comparison\`, \`<metric>_delta_absolute\`, \`<metric>_delta_percent\`. The comparison
window defaults to the immediately preceding period of the same length.

**\`delta_percent\` is a true percent everywhere.** \`+12.5\` means twelve and a half percent up.
There is one convention in this server.

## Filters

    {"key": "SPEND", "operator": ">", "values": ["50"]}

Keys are uppercase column names. Conditions are ANDed; use \`IN\` for alternatives. Operators:
${FILTER_OPERATORS.join(', ')}. \`LIKE\` is case-insensitive, because match types and states are
spelled differently on different Amazon surfaces and a capital letter should not cost you a
result set.

Three keys are not columns:

- \`ACOS_TO_TARGET\` — ACOS divided by the profile's target ACOS, so \`>= 1.1\` means "10% above
  target" on any profile in any currency.
- \`DELTA_PERCENT\` / \`DELTA_ABSOLUTE\` — take a \`metric\` and filter on its movement. Needs a
  comparison window.

## What the numbers mean

- **Absence is not zero.** Amazon omits zero-impression rows from reports, so a target missing
  from a result got no impressions *or* was never reported. Read \`get_sync_status\` before
  concluding anything from an absence.
- **Same-day data is provisional.** Sales restate for 14 or more days. Every response carries
  the latest fact date and whether it is still attributing; anchor conclusions on completed days.
- **Archived is included.** Rows are read from the fact tables, so spend on an archived campaign
  still appears, with its state on the row. A period total that silently excluded it would not
  reconcile against Amazon.
- **The product level attributes through single-ASIN ad groups only.** Ad groups advertising
  more than one ASIN cannot be split without inventing a number, so they are excluded and the
  excluded spend is reported on every product response. Read it before quoting an ASIN total.

## Per-profile context

Read \`wizardads://profiles/{profile_id}\` for a profile's settings, the doctrine document's
shape, its entity counts, its freshness, and the changes somebody made outside wizard-ads
recently. It is the context you need before proposing anything, and it arrives with the data
rather than as a separate step you have to remember.
`;
}
