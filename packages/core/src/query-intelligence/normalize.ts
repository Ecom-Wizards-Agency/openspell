/**
 * Query normalization for deterministic vocabulary matching and joins.
 *
 * The output is deliberately human-readable rather than a hash. It folds case,
 * Unicode presentation differences, punctuation and repeated whitespace, while
 * leaving word boundaries intact so a short brand token cannot match inside an
 * unrelated word.
 */

const COMBINING_MARK = /\p{M}+/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

function joinSpelledTokens(tokens: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    if ([...(tokens[index] ?? '')].length !== 1) {
      output.push(tokens[index] as string);
      index += 1;
      continue;
    }

    let end = index;
    while (end < tokens.length && [...(tokens[end] ?? '')].length === 1) end += 1;
    if (end - index >= 3) output.push(tokens.slice(index, end).join(''));
    else output.push(tokens[index] as string);
    index = end;
  }
  return output;
}

/** Normalize a customer query or vocabulary entry without stemming it. */
export function normalizeQuery(value: string): string {
  const tokens = value
    .normalize('NFKD')
    .replace(COMBINING_MARK, '')
    .toLocaleLowerCase('und')
    .replace(NON_ALPHANUMERIC, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  return joinSpelledTokens(tokens).join(' ');
}

export function queryTokens(value: string): string[] {
  const normalized = normalizeQuery(value);
  return normalized ? normalized.split(' ') : [];
}

/** Exact contiguous token matching; never substring matching. */
export function containsTokenSequence(query: string, candidate: string): boolean {
  const queryParts = queryTokens(query);
  const candidateParts = queryTokens(candidate);
  if (candidateParts.length === 0 || candidateParts.length > queryParts.length) return false;

  for (let start = 0; start <= queryParts.length - candidateParts.length; start += 1) {
    if (candidateParts.every((part, offset) => queryParts[start + offset] === part)) return true;
  }
  return false;
}
