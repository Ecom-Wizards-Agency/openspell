/**
 * "Show your work": the provenance panel's model.
 *
 * This is the product differentiator, not decoration. AdLabs publishes the
 * White Box formulas but not the numbers that went into a given row; every
 * proposal we show carries the RPC, the click count, which level of the
 * data-confidence hierarchy supplied the CVR, which ceiling bound the result
 * and whether a change cap clamped it.
 *
 * Two shapes are cloned from the recon (`tools/recon/04-optimizer.md` §3), and
 * both matter:
 *
 * - **Change reason and limit reason are separate facts.** "This bid went up
 *   because the target is under-clicked" and "it did not go up as far as the
 *   formula wanted because the ad-group ceiling bound it" are two different
 *   statements and they get two different lines.
 * - **A bound value is stated as bound.** We do not store the algorithm's
 *   unclamped number, so the panel says *that* a ceiling or a cap bound the
 *   result rather than inventing the value it would otherwise have taken.
 *
 * Every field of `RecommendationInputs` is rendered for every reason. A field
 * that is null renders as an explicit "not applicable / no clicks" line rather
 * than being dropped: a missing row reads as an oversight, and an operator
 * cannot tell an absent input from an input we forgot to show.
 */
import type { RecommendationInputs } from '@wizard-ads/shared';

export interface ProvenanceLine {
  /** Stable id, so a test can assert a line exists without matching prose. */
  key: string;
  label: string;
  value: string;
  /** Why this number is in the panel at all. */
  hint: string;
}

/** The four White Box reasons plus the two non-bid proposal sources. */
export const REASON_LABELS: Record<string, string> = {
  high_acos: 'High ACOS',
  high_spend_no_sales: 'High spend, no sales',
  low_acos: 'Low ACOS',
  low_visibility: 'Low visibility',
  flag: 'Flag',
  pacing: 'Pacing',
};

/** The published formula behind each reason, in words. */
export const REASON_FORMULAS: Record<string, string> = {
  high_acos:
    'new bid = RPC x target ACOS — the bid that lands exactly on target, recomputed from ' +
    'performance rather than stepped down from the current bid.',
  high_spend_no_sales:
    'target CPA = target ACOS x AOV defines "high spend"; the bid is set so the next ' +
    'conversion is still affordable, never paused on spend alone.',
  low_acos:
    'a step up from the current bid, ceilinged by the maximum affordable CPC that the ' +
    "level's own RPC supports.",
  low_visibility:
    'a step up to buy the clicks an RPC needs. This is the criterion a naive optimizer ' +
    'lets run forever on a low-volume keyword, which is what the ceiling exists to stop.',
  flag: 'raised by the doctrine flag engine, not by the bid formula.',
  pacing: 'raised by the run-rate governor: the account is off its monthly pace.',
};

export const CVR_SOURCE_HINT: Record<string, string> = {
  keyword: 'the target itself had enough data — the strongest claim available.',
  ad_group: 'the target was too thin, so its ad group supplied the benchmark.',
  campaign: 'neither the target nor its ad group had enough data; the campaign did.',
  profile:
    'the last resort: nothing below profile level had enough data, so this proposal rests ' +
    'on an account-wide benchmark and is the weakest claim on the list.',
};

function money(value: number | null): string {
  return value === null ? '—' : value.toFixed(4);
}

/**
 * Why the proposal was clamped, or null when it stood unbound.
 *
 * Separate from the change reason on purpose; see the file header.
 */
export function limitReason(inputs: RecommendationInputs): string | null {
  const parts: string[] = [];
  if (inputs.ceilingApplied !== null && inputs.ceilingApplied !== undefined) {
    parts.push(`the ${inputs.ceilingApplied} ceiling bound it`);
  }
  if (inputs.capClamped) parts.push('the per-cycle change cap clamped the step');
  if (parts.length === 0) return null;
  return `${parts.join(', and ')}. A cap is a ceiling, never the step: the formula wanted more.`;
}

/**
 * Every `inputs` field as a display line, in a fixed order.
 *
 * The order is the order an operator reads it in: what the data said, how
 * strong the data was, what stopped the answer, over what window.
 */
export function provenanceLines(inputs: RecommendationInputs): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [
    {
      key: 'rpc',
      label: 'Revenue per click',
      value: money(inputs.rpc ?? null),
      hint:
        inputs.rpc === null
          ? 'No clicks in the window, so there is no RPC — the proposal rests on the benchmark level below.'
          : 'The input to every White Box bid: bid = RPC x target ACOS.',
    },
    {
      key: 'clicks',
      label: 'Clicks',
      value: String(inputs.clicks),
      hint: 'How much evidence the RPC above rests on.',
    },
    {
      key: 'cvrSourceLevel',
      label: 'CVR source level',
      value: inputs.cvrSourceLevel,
      hint: CVR_SOURCE_HINT[inputs.cvrSourceLevel] ?? 'Which level of the hierarchy supplied the benchmark.',
    },
    {
      key: 'ceilingApplied',
      label: 'Ceiling applied',
      value: inputs.ceilingApplied ?? 'none',
      hint:
        inputs.ceilingApplied === null || inputs.ceilingApplied === undefined
          ? 'The formula result stood unbound.'
          : 'The named ceiling that bound the value. Without this line you could only infer that a cap bound.',
    },
    {
      key: 'capClamped',
      label: 'Change cap clamped',
      value: inputs.capClamped ? 'yes' : 'no',
      hint: inputs.capClamped
        ? 'The step hit the per-cycle cap, so the proposal is smaller than the formula asked for.'
        : 'The step was inside the per-cycle cap.',
    },
    {
      key: 'window',
      label: 'Window',
      value:
        inputs.window === undefined
          ? 'not recorded'
          : `${inputs.window.start} to ${inputs.window.end}`,
      hint: 'The optimization period the numbers above were measured over.',
    },
  ];
  return lines;
}

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

export function reasonFormula(reason: string): string {
  return REASON_FORMULAS[reason] ?? 'No published formula for this reason.';
}
