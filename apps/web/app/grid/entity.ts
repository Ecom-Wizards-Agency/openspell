import { ENTITY_LEVELS, type EntityLevel } from '@wizard-ads/ui';

export function parseGridEntity(value: string | undefined): EntityLevel {
  return ENTITY_LEVELS.includes(value as EntityLevel) ? (value as EntityLevel) : 'search_terms';
}
