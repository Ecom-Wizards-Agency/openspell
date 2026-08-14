/**
 * Campaign and ad-group names.
 *
 * A name is a list of slots joined by a delimiter, with empty slots dropped.
 * That last part is doing more work than it looks: it is how "Camp Counter is
 * only used for Halo and Auto campaigns" is enforced, and how a preset can
 * carry a slot that a given campaign has nothing to put in.
 *
 * Two presets ship. `LEGACY` is the original six-slot order every pre-existing
 * config uses; `EW` is the eight-slot convention and the default. An explicit
 * `variableOrder` always beats a preset.
 */
import { MATCH_TYPE_LABELS, type MatchType } from './constants.js';
import type { NamingSettings } from './types.js';

/** What a name slot is filled from. Every field is optional but `goal`. */
export interface NamingContext {
  goal: string;
  campaignType: string;
  matchType: string;
  productName?: string;
  targetDescriptor?: string;
  triggerWord?: string;
  keywordText?: string;
  counter?: number | null;
}

export const LEGACY_NAMING_PRESET: NamingSettings = {
  variableOrder: ['Goal', 'SP', 'MatchType', 'ProductName', 'TargetDescriptor', 'EW'],
  delimiter: ' | ',
  suffix: 'EW',
  custom1Value: '',
  custom2Value: '',
};

export const EW_NAMING_PRESET: NamingSettings = {
  variableOrder: [
    'Goal', 'AdType', 'MatchType', 'TriggerWord', 'ProductName', 'Keyword', 'CampCounter', 'EW',
  ],
  delimiter: ' | ',
  suffix: 'EW',
  custom1Value: '',
  custom2Value: '',
};

export const NAMING_PRESETS: Record<string, NamingSettings> = {
  LEGACY: LEGACY_NAMING_PRESET,
  EW: EW_NAMING_PRESET,
};

/** The default when a config names no preset and no explicit order. */
export const DEFAULT_NAMING_PRESET = EW_NAMING_PRESET;

/**
 * Slots dropped from an ad-group name: it is the shorter form of the campaign
 * name, without the prefix and suffix.
 *
 * `SP` is deliberately NOT in this set. The legacy preset keeps it in the ad
 * group name, and that is what the parity fixtures record; the EW preset uses
 * `AdType` for the same slot, so dropping `AdType` changes the new preset only.
 */
const AD_GROUP_DROPPED_SLOTS = new Set(['Goal', 'EW', 'Counter', 'Date', 'AdType', 'CampCounter']);

/** Two-digit counter, the way the source app renders it. */
function counterToken(counter: number): string {
  return counter < 10 ? `0${counter}` : String(counter);
}

/** `YYYYMMDD` from an ISO date. The date slot is the only clock-shaped one. */
function dateToken(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

function slotValue(
  variable: string,
  ctx: NamingContext,
  settings: NamingSettings,
  today: string,
): string {
  switch (variable) {
    case 'Goal':
      return ctx.goal;
    case 'SP':
    case 'AdType':
      return 'SP';
    case 'MatchType':
      return MATCH_TYPE_LABELS[ctx.matchType as MatchType] ?? ctx.matchType;
    case 'CampaignType':
      // The reference keeps an identity map here so the slot has a hook for a
      // future relabel. Until one exists, the type is its own label.
      return ctx.campaignType;
    case 'TriggerWord':
      return ctx.triggerWord || ctx.campaignType;
    case 'ProductName':
      return ctx.productName || 'ProductName';
    case 'Keyword':
      return ctx.keywordText ?? '';
    case 'TargetDescriptor':
      return ctx.targetDescriptor || 'Target';
    case 'EW':
      return settings.suffix || 'EW';
    case 'Counter':
      return ctx.counter === null || ctx.counter === undefined ? '' : counterToken(ctx.counter);
    case 'CampCounter':
      // Only Halo and Auto carry a campaign counter; for everything else the
      // empty string is how "leave it off" is expressed, because a blank slot
      // is dropped when the name is joined.
      if ((ctx.campaignType === 'Halo' || ctx.campaignType === 'Auto')
        && ctx.counter !== null && ctx.counter !== undefined) {
        return counterToken(ctx.counter);
      }
      return '';
    case 'Date':
      return dateToken(today);
    case 'Custom1':
      return settings.custom1Value || '';
    case 'Custom2':
      return settings.custom2Value || '';
    default:
      // An unknown slot renders as its own name, which makes a typo in a
      // config visible in the campaign name instead of silently missing.
      return variable;
  }
}

export function generateCampaignName(
  settings: NamingSettings,
  ctx: NamingContext,
  today: string,
): string {
  return settings.variableOrder
    .map((variable) => slotValue(variable, ctx, settings, today))
    .filter((part) => part !== '')
    .join(settings.delimiter);
}

export function generateAdGroupName(
  settings: NamingSettings,
  ctx: NamingContext,
  today: string,
): string {
  return settings.variableOrder
    .filter((variable) => !AD_GROUP_DROPPED_SLOTS.has(variable))
    .map((variable) => slotValue(variable, ctx, settings, today))
    .filter((part) => part !== '')
    .join(settings.delimiter);
}

/** Swap the product and descriptor slots, when a spec asks for it. */
export function swapNameOrder(settings: NamingSettings): NamingSettings {
  const order = [...settings.variableOrder];
  const product = order.indexOf('ProductName');
  const descriptor = order.indexOf('TargetDescriptor');
  if (product === -1 || descriptor === -1) return settings;
  order[product] = 'TargetDescriptor';
  order[descriptor] = 'ProductName';
  return { ...settings, variableOrder: order };
}

/**
 * Resolve a partial naming block against a preset.
 *
 * An explicit `variableOrder` wins over the preset, which is what keeps every
 * config written before the EW preset existed generating the same names.
 */
export function resolveNaming(
  input: (Partial<NamingSettings> & { preset?: string }) | undefined,
): NamingSettings {
  const preset = NAMING_PRESETS[(input?.preset ?? '').toUpperCase()] ?? DEFAULT_NAMING_PRESET;
  return {
    variableOrder: input?.variableOrder ?? preset.variableOrder,
    delimiter: input?.delimiter ?? preset.delimiter,
    suffix: input?.suffix ?? preset.suffix,
    custom1Value: input?.custom1Value ?? preset.custom1Value,
    custom2Value: input?.custom2Value ?? preset.custom2Value,
  };
}
