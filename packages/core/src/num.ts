/**
 * Numeric helpers whose only job is to make TypeScript agree with Python
 * digit for digit.
 *
 * Two Python behaviours are load-bearing for the parity suite:
 *
 * 1. `_safe_div`. The reference modules use a falsy check, not a null check,
 *    so a zero denominator and a missing denominator both yield `None`, and
 *    `datasource._safe_div` additionally treats a falsy-but-not-zero numerator
 *    as missing. Both variants are reproduced here rather than unified,
 *    because unifying them would change results.
 * 2. `format()` rounds half to even on the exact binary value of the double.
 *    `Number.prototype.toFixed` rounds half away from zero. The two differ
 *    exactly on ties (12.5 renders as "12" in Python and "13" in JavaScript),
 *    and ties are common in synthetic fixtures, so every f-string the ports
 *    reproduce goes through `formatFixed` below.
 */

/** `analyze._safe_div` / `crosscheck` style: null-or-zero denominator is null. */
export function safeDiv(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined || denominator === 0) return null;
  return numerator / denominator;
}

/**
 * `datasource._safe_div`: a falsy numerator that is not zero (i.e. `None`)
 * is missing, and a falsy denominator (`None` or `0`) is missing. Distinct
 * from {@link safeDiv} only for `NaN` inputs, which the fact contracts exclude.
 */
export function safeDivRow(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
): number | null {
  if (!numerator && numerator !== 0) return null;
  if (!denominator) return null;
  return numerator / denominator;
}

/**
 * Round a decimal digit string half-to-even, as Python's `format` does.
 * `digits` is the decimal expansion without sign or point; `keep` is how many
 * of its fractional digits survive.
 */
function roundHalfEvenDecimal(intPart: string, fracPart: string, keep: number): [string, string] {
  if (fracPart.length <= keep) {
    return [intPart, fracPart.padEnd(keep, '0')];
  }
  const kept = fracPart.slice(0, keep);
  const rest = fracPart.slice(keep);
  const firstDropped = rest.charCodeAt(0) - 48;
  const restNonZero = /[1-9]/.test(rest.slice(1));

  let roundUp: boolean;
  if (firstDropped > 5) roundUp = true;
  else if (firstDropped < 5) roundUp = false;
  else if (restNonZero) roundUp = true;
  else {
    // Exact tie: round to even.
    const lastKept = keep === 0 ? intPart.charCodeAt(intPart.length - 1) - 48 : kept.charCodeAt(keep - 1) - 48;
    roundUp = lastKept % 2 === 1;
  }

  if (!roundUp) return [intPart, kept];

  // Increment the kept digits as one integer.
  const combined = intPart + kept;
  const incremented = (BigInt(combined) + 1n).toString().padStart(combined.length, '0');
  const newInt = incremented.slice(0, incremented.length - keep) || '0';
  const newFrac = keep === 0 ? '' : incremented.slice(incremented.length - keep);
  return [newInt, newFrac];
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Python `format(value, '[,].<digits>f')`.
 *
 * @param value the number to render
 * @param digits fractional digits to keep
 * @param thousands insert `,` group separators (Python's `,` presentation flag)
 */
export function formatFixed(value: number, digits: number, thousands = false): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : Number.isNaN(value) ? 'nan' : '-inf';
  }
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);

  // toFixed(20) is the widest exact-ish expansion JavaScript offers and is far
  // more precision than any tie needs; the decimal rounding happens on the
  // string so that ties resolve the way Python resolves them.
  const expansion = abs < 1e21 ? abs.toFixed(20) : abs.toExponential(20);
  if (expansion.includes('e')) {
    // Values this large never appear in doctrine fixtures; fall back rather
    // than pretend to a precision we did not compute.
    return (negative ? '-' : '') + abs.toFixed(digits);
  }
  const dot = expansion.indexOf('.');
  const intPart = dot === -1 ? expansion : expansion.slice(0, dot);
  const fracPart = dot === -1 ? '' : expansion.slice(dot + 1);
  const [roundedInt, roundedFrac] = roundHalfEvenDecimal(intPart, fracPart, digits);

  const body = (thousands ? groupThousands(roundedInt) : roundedInt) + (digits > 0 ? `.${roundedFrac}` : '');
  // Python keeps the sign of a negative value even when it rounds to zero.
  return negative ? `-${body}` : body;
}

/** Python `f"${v:,.2f}"`. */
export function formatMoney(value: number): string {
  return `$${formatFixed(value, 2, true)}`;
}

/** Python `f"{v:,.0f}"`. */
export function formatCount(value: number): string {
  return formatFixed(value, 0, true);
}
