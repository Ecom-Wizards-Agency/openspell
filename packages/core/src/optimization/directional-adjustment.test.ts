import { DirectionalAdjustmentProvenance, OptimizationGroup } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  adjustBidAwayFromMechanicalValue,
  adjustPlacementAwayFromMechanicalValue,
} from './directional-adjustment.js';

const group = OptimizationGroup.parse({
  id: '00000000-0000-4000-8000-000000000201',
  orgId: '00000000-0000-4000-8000-000000000202',
  profileId: '00000000-0000-4000-8000-000000000203',
  name: 'Synthetic bounded group',
  role: 'discovery',
  targetAcos: 0.2,
  bidFloor: 0.2,
  bidCeiling: 2,
  bidIncreaseCap: 0.5,
  bidDecreaseCap: 0.5,
  placementIncreaseCap: 0.5,
  placementDecreaseCap: 0.5,
  exclusions: [],
  cadence: 'synthetic cadence',
  prioritization: 'balanced',
  enabled: true,
});

describe('non-mechanical bid adjustment', () => {
  it('moves a mechanical increase by one legal cent after constraints', () => {
    const result = adjustBidAwayFromMechanicalValue({
      group,
      currentValue: 0.9,
      requestedValue: 1,
      direction: 'increase',
      hardFloor: 0.2,
      hardCeiling: 2,
      mechanicalStep: 0.05,
    });

    expect(result.provenance).toEqual({
      requestedValue: 1,
      constrainedValue: 1,
      finalValue: 1.01,
      direction: 'increase',
      adjustmentKind: 'one_cent',
      hardBoundPreventedAdjustment: false,
    });
    expect(result.groupId).toBe(group.id);
    expect(() => DirectionalAdjustmentProvenance.parse(result.provenance)).not.toThrow();
  });

  it('moves a mechanical decrease by one legal cent', () => {
    const result = adjustBidAwayFromMechanicalValue({
      group,
      currentValue: 1.2,
      requestedValue: 1.05,
      direction: 'decrease',
      hardFloor: 0.2,
      hardCeiling: 2,
      mechanicalStep: 0.05,
    });

    expect(result.provenance.finalValue).toBe(1.04);
    expect(result.provenance.adjustmentKind).toBe('one_cent');
  });

  it('keeps a binding hard ceiling and records why no cent was legal', () => {
    const result = adjustBidAwayFromMechanicalValue({
      group,
      currentValue: 0.9,
      requestedValue: 1.1,
      direction: 'increase',
      hardFloor: 0.2,
      hardCeiling: 1,
      mechanicalStep: 0.05,
    });

    expect(result.provenance).toMatchObject({
      constrainedValue: 1,
      finalValue: 1,
      adjustmentKind: 'none',
      hardBoundPreventedAdjustment: true,
    });
    expect(result.legalRange.maximum).toBe(1);
  });

  it('lets a group change cap bind before de-rounding', () => {
    const result = adjustBidAwayFromMechanicalValue({
      group: { ...group, bidIncreaseCap: 0.25 },
      currentValue: 0.8,
      requestedValue: 1.4,
      direction: 'increase',
      hardFloor: null,
      hardCeiling: null,
      mechanicalStep: 0.05,
    });

    expect(result.legalRange.maximum).toBe(1);
    expect(result.provenance.finalValue).toBe(1);
    expect(result.provenance.hardBoundPreventedAdjustment).toBe(true);
  });

  it('leaves an already non-mechanical bid unchanged', () => {
    const result = adjustBidAwayFromMechanicalValue({
      group,
      currentValue: 0.9,
      requestedValue: 0.98,
      direction: 'increase',
      hardFloor: 0.2,
      hardCeiling: 2,
      mechanicalStep: 0.05,
    });

    expect(result.provenance).toMatchObject({
      constrainedValue: 0.98,
      finalValue: 0.98,
      adjustmentKind: 'none',
      hardBoundPreventedAdjustment: false,
    });
  });

  it('preserves bounds and direction over a synthetic property matrix', () => {
    for (let currentCents = 50; currentCents <= 140; currentCents += 10) {
      for (const direction of ['increase', 'decrease'] as const) {
        const currentValue = currentCents / 100;
        const requestedValue =
          direction === 'increase' ? currentValue + 0.15 : currentValue - 0.15;
        const result = adjustBidAwayFromMechanicalValue({
          group,
          currentValue,
          requestedValue,
          direction,
          hardFloor: 0.2,
          hardCeiling: 2,
          mechanicalStep: 0.05,
        });
        const { finalValue, constrainedValue, adjustmentKind } = result.provenance;

        expect(finalValue).toBeGreaterThanOrEqual(result.legalRange.minimum);
        expect(finalValue).toBeLessThanOrEqual(result.legalRange.maximum);
        if (adjustmentKind === 'one_cent') {
          expect(Math.abs(finalValue - constrainedValue)).toBeCloseTo(0.01, 8);
          expect(direction === 'increase' ? finalValue > currentValue : finalValue < currentValue).toBe(
            true,
          );
        }
      }
    }
  });
});

describe('non-mechanical placement adjustment', () => {
  it('moves a mechanical integer by one point after bounding', () => {
    const result = adjustPlacementAwayFromMechanicalValue({
      group,
      currentValue: 20,
      requestedValue: 50,
      direction: 'increase',
      hardFloor: 0,
      hardCeiling: 900,
      mechanicalStep: 5,
    });

    expect(result.provenance).toMatchObject({
      constrainedValue: 50,
      finalValue: 51,
      adjustmentKind: 'bounded_integer',
      hardBoundPreventedAdjustment: false,
    });
  });

  it('respects the placement multiplier cap when no directional point is legal', () => {
    const result = adjustPlacementAwayFromMechanicalValue({
      group: { ...group, placementIncreaseCap: 0.1 },
      currentValue: 0,
      requestedValue: 30,
      direction: 'increase',
      hardFloor: 0,
      hardCeiling: 900,
      mechanicalStep: 5,
    });

    expect(result.legalRange.maximum).toBe(10);
    expect(result.provenance).toMatchObject({
      constrainedValue: 10,
      finalValue: 10,
      adjustmentKind: 'none',
      hardBoundPreventedAdjustment: true,
    });
  });

  it('moves a mechanical decrease down by one point', () => {
    const result = adjustPlacementAwayFromMechanicalValue({
      group,
      currentValue: 60,
      requestedValue: 50,
      direction: 'decrease',
      hardFloor: 0,
      hardCeiling: 900,
      mechanicalStep: 5,
    });

    expect(result.provenance.finalValue).toBe(49);
    expect(result.provenance.adjustmentKind).toBe('bounded_integer');
  });

  it('preserves integer bounds over a synthetic property matrix', () => {
    for (let currentValue = 0; currentValue <= 100; currentValue += 10) {
      const result = adjustPlacementAwayFromMechanicalValue({
        group,
        currentValue,
        requestedValue: currentValue + 20,
        direction: 'increase',
        hardFloor: 0,
        hardCeiling: 900,
        mechanicalStep: 5,
      });

      expect(Number.isInteger(result.provenance.finalValue)).toBe(true);
      expect(result.provenance.finalValue).toBeGreaterThanOrEqual(result.legalRange.minimum);
      expect(result.provenance.finalValue).toBeLessThanOrEqual(result.legalRange.maximum);
      if (result.provenance.adjustmentKind === 'bounded_integer') {
        expect(result.provenance.finalValue - result.provenance.constrainedValue).toBe(1);
      }
    }
  });
});
