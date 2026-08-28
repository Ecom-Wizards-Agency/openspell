import type {
  DirectionalAdjustmentProvenance,
  OptimizationGroup,
} from '@wizard-ads/shared';

export interface DirectionalAdjustmentResult {
  groupId: OptimizationGroup['id'];
  provenance: DirectionalAdjustmentProvenance;
  legalRange: { minimum: number; maximum: number };
}

export interface NonMechanicalBidRequest {
  group: OptimizationGroup;
  currentValue: number;
  requestedValue: number;
  direction: DirectionalAdjustmentProvenance['direction'];
  /** Additional provider/economic floor already resolved by the caller. */
  hardFloor: number | null;
  /** Additional provider/economic ceiling already resolved by the caller. */
  hardCeiling: number | null;
  /** Tenant-supplied definition of a mechanically rounded bid, for example a currency step. */
  mechanicalStep: number;
}

export interface NonMechanicalPlacementRequest {
  group: OptimizationGroup;
  currentValue: number;
  requestedValue: number;
  direction: DirectionalAdjustmentProvenance['direction'];
  hardFloor: number;
  hardCeiling: number;
  /** Tenant-supplied integer interval considered mechanically rounded. */
  mechanicalStep: number;
}

const CENTS_PER_CURRENCY_UNIT = 100;
const PERCENT_MULTIPLIER_BASE = 100;

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`);
}

function assertNonnegative(value: number, field: string): void {
  assertFinite(value, field);
  if (value < 0) throw new RangeError(`${field} must be nonnegative`);
}

function assertDirection(
  currentValue: number,
  requestedValue: number,
  direction: DirectionalAdjustmentProvenance['direction'],
): void {
  if (direction === 'increase' && requestedValue < currentValue) {
    throw new RangeError('an increase request must not be below the current value');
  }
  if (direction === 'decrease' && requestedValue > currentValue) {
    throw new RangeError('a decrease request must not be above the current value');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function toCentUnits(value: number): number {
  return Math.round(value * CENTS_PER_CURRENCY_UNIT);
}

function fromCentUnits(value: number): number {
  return value / CENTS_PER_CURRENCY_UNIT;
}

function isMultiple(value: number, step: number): boolean {
  return value % step === 0;
}

/**
 * Apply group caps and all hard bounds first, then move a mechanical bid by
 * exactly one legal cent in the intended direction. A binding bound always
 * wins over cosmetic de-rounding.
 */
export function adjustBidAwayFromMechanicalValue(
  request: NonMechanicalBidRequest,
): DirectionalAdjustmentResult {
  const { group } = request;
  assertNonnegative(request.currentValue, 'currentValue');
  assertNonnegative(request.requestedValue, 'requestedValue');
  assertNonnegative(group.bidIncreaseCap, 'group.bidIncreaseCap');
  assertNonnegative(group.bidDecreaseCap, 'group.bidDecreaseCap');
  assertNonnegative(request.mechanicalStep, 'mechanicalStep');
  if (request.mechanicalStep === 0) {
    throw new RangeError('mechanicalStep must be greater than zero');
  }
  if (request.hardFloor !== null) assertNonnegative(request.hardFloor, 'hardFloor');
  if (request.hardCeiling !== null) assertNonnegative(request.hardCeiling, 'hardCeiling');
  if (group.bidFloor !== null) assertNonnegative(group.bidFloor, 'group.bidFloor');
  if (group.bidCeiling !== null) assertNonnegative(group.bidCeiling, 'group.bidCeiling');
  assertDirection(request.currentValue, request.requestedValue, request.direction);

  const floorCandidates = [
    0,
    request.currentValue * (1 - group.bidDecreaseCap),
    group.bidFloor,
    request.hardFloor,
  ].filter((value): value is number => value !== null);
  const ceilingCandidates = [
    request.currentValue * (1 + group.bidIncreaseCap),
    group.bidCeiling,
    request.hardCeiling,
  ].filter((value): value is number => value !== null);
  const rawMinimum = Math.max(...floorCandidates);
  const rawMaximum = Math.min(...ceilingCandidates);
  const minimumUnits = Math.ceil(rawMinimum * CENTS_PER_CURRENCY_UNIT - Number.EPSILON);
  const maximumUnits = Math.floor(rawMaximum * CENTS_PER_CURRENCY_UNIT + Number.EPSILON);
  if (minimumUnits > maximumUnits) {
    throw new RangeError('bid constraints leave no legal cent-denominated value');
  }

  const requestedUnits = toCentUnits(request.requestedValue);
  const constrainedUnits = clamp(requestedUnits, minimumUnits, maximumUnits);
  const mechanicalStepUnits = toCentUnits(request.mechanicalStep);
  if (
    mechanicalStepUnits <= 0 ||
    Math.abs(fromCentUnits(mechanicalStepUnits) - request.mechanicalStep) > Number.EPSILON
  ) {
    throw new RangeError('mechanicalStep must be expressible in whole cents');
  }

  const mechanical = isMultiple(constrainedUnits, mechanicalStepUnits);
  const directionalCandidate =
    constrainedUnits + (request.direction === 'increase' ? 1 : -1);
  const candidateWithinBounds =
    directionalCandidate >= minimumUnits && directionalCandidate <= maximumUnits;
  const candidatePreservesDirection =
    request.direction === 'increase'
      ? directionalCandidate > toCentUnits(request.currentValue)
      : directionalCandidate < toCentUnits(request.currentValue);
  const adjust = mechanical && candidateWithinBounds && candidatePreservesDirection;
  const finalUnits = adjust ? directionalCandidate : constrainedUnits;

  return {
    groupId: group.id,
    legalRange: {
      minimum: fromCentUnits(minimumUnits),
      maximum: fromCentUnits(maximumUnits),
    },
    provenance: {
      requestedValue: request.requestedValue,
      constrainedValue: fromCentUnits(constrainedUnits),
      finalValue: fromCentUnits(finalUnits),
      direction: request.direction,
      adjustmentKind: adjust ? 'one_cent' : 'none',
      hardBoundPreventedAdjustment: mechanical && !adjust && !candidateWithinBounds,
    },
  };
}

/**
 * Placement caps apply to the multiplier represented by Amazon's integer
 * percentage, matching the White Box placement calculation. Once bounded, a
 * mechanical integer moves by one percentage point when that remains legal.
 */
export function adjustPlacementAwayFromMechanicalValue(
  request: NonMechanicalPlacementRequest,
): DirectionalAdjustmentResult {
  const { group } = request;
  assertNonnegative(request.currentValue, 'currentValue');
  assertNonnegative(request.requestedValue, 'requestedValue');
  assertNonnegative(group.placementIncreaseCap, 'group.placementIncreaseCap');
  assertNonnegative(group.placementDecreaseCap, 'group.placementDecreaseCap');
  assertNonnegative(request.hardFloor, 'hardFloor');
  assertNonnegative(request.hardCeiling, 'hardCeiling');
  if (!Number.isInteger(request.mechanicalStep) || request.mechanicalStep < 1) {
    throw new RangeError('mechanicalStep must be a positive integer');
  }
  if (request.hardFloor > request.hardCeiling) {
    throw new RangeError('hardFloor must not exceed hardCeiling');
  }
  assertDirection(request.currentValue, request.requestedValue, request.direction);

  const currentMultiplier = 1 + request.currentValue / PERCENT_MULTIPLIER_BASE;
  const capMinimum =
    (currentMultiplier * (1 - group.placementDecreaseCap) - 1) *
    PERCENT_MULTIPLIER_BASE;
  const capMaximum =
    (currentMultiplier * (1 + group.placementIncreaseCap) - 1) *
    PERCENT_MULTIPLIER_BASE;
  const minimum = Math.ceil(Math.max(request.hardFloor, capMinimum) - Number.EPSILON);
  const maximum = Math.floor(Math.min(request.hardCeiling, capMaximum) + Number.EPSILON);
  if (minimum > maximum) {
    throw new RangeError('placement constraints leave no legal integer value');
  }

  const constrained = clamp(Math.round(request.requestedValue), minimum, maximum);
  const mechanical = isMultiple(constrained, request.mechanicalStep);
  const directionalCandidate = constrained + (request.direction === 'increase' ? 1 : -1);
  const candidateWithinBounds = directionalCandidate >= minimum && directionalCandidate <= maximum;
  const candidatePreservesDirection =
    request.direction === 'increase'
      ? directionalCandidate > request.currentValue
      : directionalCandidate < request.currentValue;
  const adjust = mechanical && candidateWithinBounds && candidatePreservesDirection;
  const finalValue = adjust ? directionalCandidate : constrained;

  return {
    groupId: group.id,
    legalRange: { minimum, maximum },
    provenance: {
      requestedValue: request.requestedValue,
      constrainedValue: constrained,
      finalValue,
      direction: request.direction,
      adjustmentKind: adjust ? 'bounded_integer' : 'none',
      hardBoundPreventedAdjustment: mechanical && !adjust && !candidateWithinBounds,
    },
  };
}
