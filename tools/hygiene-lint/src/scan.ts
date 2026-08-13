/**
 * Public-repo hygiene scanner.
 *
 * wizard-ads is public. The things that must never reach it are, in order of
 * how easily they slip in: an operator's absolute home path, a credential, a
 * client's name, and a whole directory nobody meant to track. This module is
 * the pure half (given file contents, return findings); `cli.ts` is the half
 * that asks git what is tracked.
 *
 * Patterns that would otherwise match this file are assembled from fragments,
 * so the scanner does not trip over its own source, and `tools/hygiene-lint/`
 * is exempt from the content rules for the same reason.
 */

export type HygieneRule =
  | 'absolute-user-path'
  | 'candidate-secret'
  | 'denylisted-term'
  | 'untracked-top-level-dir';

export interface Finding {
  rule: HygieneRule;
  path: string;
  /** 1-based; 0 when the finding is about the path itself. */
  line: number;
  message: string;
  /** The offending text, truncated and partially masked. */
  excerpt: string;
}

export interface ScanTarget {
  path: string;
  content: string;
}

export interface ScanOptions {
  /** Terms from the operator's gitignored denylist. Case-insensitive. */
  denylist?: readonly string[];
  /** Path prefixes exempt from the content rules. */
  exemptPrefixes?: readonly string[];
}

/** This scanner necessarily contains the patterns it looks for. */
const DEFAULT_EXEMPT_PREFIXES = ['tools/hygiene-lint/'] as const;

/** Generated files whose high-entropy strings are integrity hashes, not secrets. */
const SECRET_SCAN_EXEMPT = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'fixtures/golden/',
] as const;

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.otf', '.xlsx', '.xlsm', '.docx',
];

/**
 * Home-directory prefixes. Assembled from fragments so a naive grep of this
 * repo for an operator path finds nothing, including here.
 */
const USER_PATH_PATTERNS: readonly RegExp[] = [
  new RegExp(`/${'Us'}${'ers'}/[A-Za-z0-9._-]+`, 'g'),
  new RegExp(`/${'ho'}${'me'}/[a-z][a-z0-9._-]*`, 'g'),
  new RegExp(`[A-Z]:\\\\${'Us'}${'ers'}\\\\[A-Za-z0-9._-]+`, 'g'),
];

/** Credentials that announce themselves by prefix. No keyword needed. */
const SECRET_PREFIX_PATTERNS: readonly { re: RegExp; what: string }[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'AWS access key id' },
  { re: /\bghp_[A-Za-z0-9]{30,}\b/g, what: 'GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, what: 'GitHub fine-grained token' },
  { re: /\bsk-[A-Za-z0-9_-]{24,}\b/g, what: 'API secret key' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{12,}\b/g, what: 'Slack token' },
  { re: /\bAtz[ar]\|[A-Za-z0-9_.-]{20,}/g, what: 'Amazon LWA token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: 'private key block' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g, what: 'JWT' },
];

/** `secret: "...."`, `apiKey = '....'`, and friends. */
const SECRET_ASSIGNMENT = new RegExp(
  String.raw`\b(api[_-]?key|secret|client[_-]?secret|refresh[_-]?token|access[_-]?token|auth[_-]?token|bearer|password|passwd|private[_-]?key|service[_-]?role[_-]?key)\b["']?\s*[:=]\s*["']?([^\s"',;{}]{16,})`,
  'gi',
);

/** Values that are obviously not a live credential. */
const PLACEHOLDER = new RegExp(
  String.raw`^(<|\$\{|process\.env|import\.meta|null$|undefined$)|` +
    String.raw`(your|example|placeholder|changeme|change-me|redacted|fake|dummy|sample|template|todo|xxx+|\.\.\.)`,
  'i',
);

const QUOTED_STRING = /(['"`])([^'"`\n]{40,})\1/g;
const ENTROPY_MIN = 4.5;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Mask the middle so a finding can be printed in CI logs without leaking it. */
function mask(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= 24) return flat;
  return `${flat.slice(0, 12)}...${flat.slice(-6)} (${flat.length} chars)`;
}

function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

function hasPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content[i] === '\n') line += 1;
  return line;
}

function findAll(
  content: string,
  re: RegExp,
  onMatch: (match: RegExpExecArray) => Omit<Finding, 'path' | 'line'> | null,
  path: string,
  out: Finding[],
): void {
  const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match !== null) {
    const finding = onMatch(match);
    if (finding) out.push({ ...finding, path, line: lineOf(content, match.index) });
    match = pattern.exec(content);
  }
}

/** Rule (a): an absolute path into somebody's home directory. */
function scanUserPaths(target: ScanTarget, out: Finding[]): void {
  for (const re of USER_PATH_PATTERNS) {
    findAll(
      target.content,
      re,
      (match) => ({
        rule: 'absolute-user-path',
        message:
          'absolute home-directory path in a tracked file. Use a repo-relative path, ' +
          'an env var, or a gitignored _local/ pointer file.',
        excerpt: match[0],
      }),
      target.path,
      out,
    );
  }
}

/** Rule (b): candidate secrets, by prefix, by keyword assignment, by entropy. */
function scanSecrets(target: ScanTarget, out: Finding[]): void {
  if (hasPrefix(target.path, SECRET_SCAN_EXEMPT)) return;

  for (const { re, what } of SECRET_PREFIX_PATTERNS) {
    findAll(
      target.content,
      re,
      (match) => ({
        rule: 'candidate-secret',
        message: `looks like a ${what}`,
        excerpt: mask(match[0]),
      }),
      target.path,
      out,
    );
  }

  findAll(
    target.content,
    SECRET_ASSIGNMENT,
    (match) => {
      const value = match[2];
      if (value === undefined || PLACEHOLDER.test(value)) return null;
      if (new Set(value).size <= 2) return null;
      return {
        rule: 'candidate-secret',
        message: `credential-shaped assignment to "${match[1] ?? 'secret'}"`,
        excerpt: mask(value),
      };
    },
    target.path,
    out,
  );

  findAll(
    target.content,
    QUOTED_STRING,
    (match) => {
      const value = match[2];
      if (value === undefined) return null;
      if (/^(https?|file|data|postgres|redis):/i.test(value)) return null;
      if (/\s/.test(value)) return null;
      if (PLACEHOLDER.test(value)) return null;
      if (shannonEntropy(value) < ENTROPY_MIN) return null;
      return {
        rule: 'candidate-secret',
        message: `high-entropy literal (${shannonEntropy(value).toFixed(2)} bits/char)`,
        excerpt: mask(value),
      };
    },
    target.path,
    out,
  );
}

/** Rule (c): a term from the operator's client denylist. */
function scanDenylist(target: ScanTarget, denylist: readonly string[], out: Finding[]): void {
  for (const raw of denylist) {
    const term = raw.trim();
    if (!term) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    findAll(
      target.content,
      re,
      (match) => ({
        rule: 'denylisted-term',
        message: `denylisted term "${term}" in a tracked file`,
        excerpt: match[0],
      }),
      target.path,
      out,
    );
  }
}

/**
 * Scan tracked file contents. Rules (a), (b) and (c).
 */
export function scanFiles(
  targets: readonly ScanTarget[],
  options: ScanOptions = {},
): Finding[] {
  const exempt = options.exemptPrefixes ?? DEFAULT_EXEMPT_PREFIXES;
  const denylist = options.denylist ?? [];
  const out: Finding[] = [];

  for (const target of targets) {
    if (isBinaryPath(target.path) || target.content.includes('\0')) continue;
    if (hasPrefix(target.path, exempt)) continue;
    scanUserPaths(target, out);
    scanSecrets(target, out);
    scanDenylist(target, denylist, out);
  }

  return out;
}

/**
 * Rule (d): a top-level directory that is neither tracked nor ignored. It is
 * either about to be committed by accident or about to be lost by accident,
 * and both are worth one line of output.
 *
 * Input is `git ls-files --others --exclude-standard --directory`, which
 * collapses a wholly-untracked directory into a single `name/` entry and
 * otherwise lists individual paths. So an entry of exactly one segment plus a
 * trailing slash means "this entire top-level directory is unknown to git";
 * anything deeper means the directory is already partly tracked, and a new file
 * inside a tracked tree is an ordinary uncommitted change, not a hygiene
 * problem. Untracked top-level *files* are likewise git's business, not this
 * linter's.
 */
const TOP_LEVEL_DIR = /^[^/]+\/$/;

export function scanTopLevelDirs(untrackedEntries: readonly string[]): Finding[] {
  const dirs = new Set<string>();
  for (const entry of untrackedEntries) {
    const trimmed = entry.trim();
    if (TOP_LEVEL_DIR.test(trimmed)) dirs.add(trimmed);
  }

  return [...dirs].sort().map((dir) => ({
    rule: 'untracked-top-level-dir' as const,
    path: dir,
    line: 0,
    message:
      'top-level directory is neither tracked nor ignored. Add it to the repo or to .gitignore.',
    excerpt: dir,
  }));
}

/** One line per finding, stable enough to diff between runs. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => `${f.path}:${f.line}  [${f.rule}] ${f.message}\n    ${f.excerpt}`)
    .join('\n');
}

/** Parse the operator's denylist file: one term per line, `#` comments. */
export function parseDenylist(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}
