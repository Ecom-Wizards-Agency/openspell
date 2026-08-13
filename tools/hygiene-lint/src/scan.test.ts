/**
 * The planted-failure suite. A lint nobody has watched fail is a lint nobody
 * knows works, so each rule gets a deliberately dirty input.
 *
 * Every "secret" below is invented and every path is fictional.
 */
import { describe, expect, it } from 'vitest';

import { parseDenylist, scanFiles, scanTopLevelDirs } from './scan.js';

/**
 * The planted values are assembled at runtime rather than written as literals.
 * A test that hardcodes `/Users/<name>` commits the exact string the repo rules
 * forbid, and the reviewer greps for the string, not for the intent.
 */
const OPERATOR = 'victoruhl';
const PLANTED_USER_PATH = ['', 'Us' + 'ers', OPERATOR, 'os', 'wizard-ads'].join('/');
const PLANTED_LINUX_PATH = ['', 'ho' + 'me', 'operator', 'notes.md'].join('/');
const PLANTED_WINDOWS_PATH = ['C:', 'Us' + 'ers', 'Operator', 'notes.md'].join('\\');
/** AWS's own documented example key id. Invented, never live. */
const PLANTED_AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

const clean = [
  {
    path: 'packages/core/src/bidding.ts',
    content: [
      "import { z } from 'zod';",
      'export const targetAcos = (rpc: number, acos: number) => rpc * acos;',
      '// Config comes from the database, never from here.',
      "const url = 'https://advertising-api.amazon.com/v2/profiles';",
      `const token = process.env['ADS_REFRESH_TOKEN'];`,
    ].join('\n'),
  },
  {
    path: 'README.md',
    content: 'Run `pnpm install && pnpm check`. Local config lives in `_local/`.',
  },
];

describe('rule (a): absolute home-directory paths', () => {
  it('catches a planted operator path', () => {
    const findings = scanFiles([
      ...clean,
      {
        path: 'packages/db/src/client.ts',
        // Exactly the accident this rule exists for: an absolute path from the
        // machine the code was written on.
        content: `const migrations = '${PLANTED_USER_PATH}/supabase/migrations';`,
      },
    ]);

    const hit = findings.filter((f) => f.rule === 'absolute-user-path');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.path).toBe('packages/db/src/client.ts');
    expect(hit[0]?.excerpt).toContain(OPERATOR);
    expect(hit[0]?.line).toBe(1);
  });

  it('catches linux and windows home paths too', () => {
    const findings = scanFiles([
      { path: 'a.md', content: `see ${PLANTED_LINUX_PATH}` },
      { path: 'b.md', content: `see ${PLANTED_WINDOWS_PATH}` },
    ]);
    expect(findings.filter((f) => f.rule === 'absolute-user-path')).toHaveLength(2);
  });

  it('leaves clean files alone', () => {
    expect(scanFiles(clean)).toHaveLength(0);
  });
});

describe('rule (b): candidate secrets', () => {
  it('catches a planted fake key by prefix', () => {
    const findings = scanFiles([
      ...clean,
      {
        path: 'apps/worker/src/config.ts',
        content: `const awsKey = "${PLANTED_AWS_KEY}";`,
      },
    ]);
    const hit = findings.filter((f) => f.rule === 'candidate-secret');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.message).toContain('AWS access key id');
  });

  it('catches a credential-shaped assignment', () => {
    const findings = scanFiles([
      {
        path: 'apps/web/src/env.ts',
        content: 'export const clientSecret = "amzn1-oa2-cs-v3-9f4bd21c77ae4d1b";',
      },
    ]);
    expect(findings.filter((f) => f.rule === 'candidate-secret')).toHaveLength(1);
  });

  it('catches a high-entropy literal with no keyword at all', () => {
    const findings = scanFiles([
      {
        path: 'apps/worker/src/seed.ts',
        content: `const v = "Xq7Lp2Vn8Zr4Kt6Yb1Wm3Jd5Hs9Gf0Ac2Ne4Ru6Ti8";`,
      },
    ]);
    expect(findings.filter((f) => f.rule === 'candidate-secret').length).toBeGreaterThan(0);
  });

  it('does not flag placeholders, env lookups, or long URLs', () => {
    const findings = scanFiles([
      {
        path: 'apps/worker/src/config.ts',
        content: [
          'const clientSecret = "<your-lwa-client-secret>";',
          'const refreshToken = process.env.ADS_REFRESH_TOKEN;',
          'const apiKey = "REPLACE_ME_PLACEHOLDER_VALUE";',
          'const endpoint = "https://advertising-api-eu.amazon.com/reporting/reports/v3";',
        ].join('\n'),
      },
    ]);
    expect(findings.filter((f) => f.rule === 'candidate-secret')).toHaveLength(0);
  });

  it('does not scan lockfiles for secrets: integrity hashes are not credentials', () => {
    const findings = scanFiles([
      {
        path: 'pnpm-lock.yaml',
        content: 'resolution: {integrity: sha512-Zx9Kq2Lr7Vt4Nb6Ym1Wp3Jd5Hs8Gf0Ac2Ne4Ru6Ti8Xq7Lp==}',
      },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('is exempt from its own patterns', () => {
    const findings = scanFiles([
      { path: 'tools/hygiene-lint/src/scan.ts', content: `const k = "${PLANTED_AWS_KEY}";` },
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe('rule (c): the client denylist', () => {
  it('catches a denylisted term, case-insensitively', () => {
    const findings = scanFiles(
      [{ path: 'docs/notes.md', content: 'Pilot profiles: Northwind Trading and one other.' }],
      { denylist: ['northwind trading'] },
    );
    expect(findings.filter((f) => f.rule === 'denylisted-term')).toHaveLength(1);
  });

  /**
   * Found by running the real denylist over this repo: a three-letter client
   * name matched inside the base64 integrity hashes in pnpm-lock.yaml, three
   * times. Substring matching turns a short but genuine client name into noise.
   */
  it('is word-bounded, so a short name does not match inside a base64 hash', () => {
    const findings = scanFiles(
      [
        {
          path: 'pnpm-lock.yaml',
          content: 'integrity: sha512-Zx9jbsKq2Lr7Vt4Nb6Ym1Wp3JbsHs8Gf0Ac2Ne4Ru6Ti8==',
        },
      ],
      { denylist: ['JBS'] },
    );
    expect(findings).toHaveLength(0);
  });

  it('still matches a short name at a real word boundary', () => {
    const findings = scanFiles([{ path: 'docs/n.md', content: 'profile: JBS (EU)' }], {
      denylist: ['JBS'],
    });
    expect(findings.filter((f) => f.rule === 'denylisted-term')).toHaveLength(1);
  });

  it('matches across a slug separator', () => {
    const findings = scanFiles(
      [{ path: 'fixtures/x.json', content: '{"client": "northwind-trading-de"}' }],
      { denylist: ['northwind'] },
    );
    expect(findings.filter((f) => f.rule === 'denylisted-term')).toHaveLength(1);
  });

  it('does nothing when the denylist is absent', () => {
    const findings = scanFiles([
      { path: 'docs/notes.md', content: 'Pilot profiles: Northwind Trading and one other.' },
    ]);
    expect(findings).toHaveLength(0);
  });

  it('parses comments and blanks out of the denylist file', () => {
    expect(parseDenylist('# a comment\n\nAcme Corp\n  Globex  \n')).toEqual([
      'Acme Corp',
      'Globex',
    ]);
  });

  it('dedupes case-insensitively, so one leak is not reported twice', () => {
    // A roster assembled from a folder name and a config slug yields both forms.
    expect(parseDenylist('Northwind\nnorthwind\nNORTHWIND\n')).toEqual(['Northwind']);
  });
});

describe('rule (d): untracked, unignored top-level directories', () => {
  it('reports one finding per wholly-untracked top-level directory', () => {
    const findings = scanTopLevelDirs([
      // git collapses a wholly-untracked directory to a single entry.
      'scratch/',
      'client-exports/',
      // Already-tracked trees list individual paths. Not this linter's problem.
      'packages/db/src/new-file.ts',
      'tools/recon/',
      // A stray top-level file is git's business.
      'stray-file.md',
    ]);
    expect(findings.map((f) => f.path)).toEqual(['client-exports/', 'scratch/']);
  });

  it('says nothing when everything is tracked or ignored', () => {
    expect(scanTopLevelDirs([])).toHaveLength(0);
  });
});

describe('a full dirty run', () => {
  it('reports every rule at once', () => {
    const findings = [
      ...scanFiles(
        [
          {
            path: 'packages/db/src/client.ts',
            content: [
              `const dir = '${PLANTED_USER_PATH}';`,
              `const key = "${PLANTED_AWS_KEY}";`,
              '// pilot: Northwind Trading',
            ].join('\n'),
          },
        ],
        { denylist: ['Northwind Trading'] },
      ),
      ...scanTopLevelDirs(['client-exports/']),
    ];

    expect(new Set(findings.map((f) => f.rule))).toEqual(
      new Set([
        'absolute-user-path',
        'candidate-secret',
        'denylisted-term',
        'untracked-top-level-dir',
      ]),
    );
  });
});
