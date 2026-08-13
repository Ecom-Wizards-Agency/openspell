/**
 * The two published economics helpers every bid target rests on.
 *
 * Break-even ACOS is where advertising eats the entire unit margin; target
 * ACOS is a business decision made against it, not a number typed from
 * memory. Target CPA turns a target ACOS into the spend threshold that decides
 * when a non-converting keyword has had enough rope, which is why the engine
 * never carries a flat "$20 and no sales" rule: a $200 product can afford $60
 * per acquisition and a $15 product cannot afford $5.
 */

export interface UnitEconomics {
  salePrice: number;
  costOfGoods: number;
  amazonFees: number;
}

/** `(price - COGS - fees) / price`, as a fraction. */
export function breakEvenAcos({ salePrice, costOfGoods, amazonFees }: UnitEconomics): number | null {
  if (salePrice <= 0) return null;
  return (salePrice - costOfGoods - amazonFees) / salePrice;
}

/** `targetAcos x AOV`: the spend at which a non-converting target is over target. */
export function targetCpa(targetAcos: number, aov: number): number {
  return targetAcos * aov;
}
