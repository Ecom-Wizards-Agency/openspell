/**
 * The parity suite: every committed campaign golden replayed against the port.
 *
 * The goldens come from `fixtures/generate/generate_campaign_goldens.py`, run
 * against the real Python reference toolkit and committed, so this suite runs
 * in CI with no Python, no reference checkout and no network. If the port
 * drifts from the doctrine it was ported from, a case fails here and names
 * itself.
 *
 * Four things are compared, and the third is the one that matters most:
 *
 *   the campaigns  name for name, bid for bid, every resolved field
 *   the bulk rows  cell for cell, in row order, keyed by Amazon column
 *   the workbook   written to bytes, read back, diffed against the workbook
 *                  openpyxl wrote for the same fixture
 *   the gates      every preflight and QA-gate string, word for word
 *
 * The workbook check goes through the file rather than around it. Comparing
 * the grid we were about to write would only prove the projection agrees with
 * itself; writing the .xlsx, parsing the bytes back and diffing that against
 * what Python's writer produced is what proves the file is the same file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EntityRow } from '@wizard-ads/shared';

import { SP_COLUMNS } from './constants.js';
import { specsFromSections, type KeywordSection } from './keywords.js';
import { buildCampaignPlan, planToSheet } from './plan.js';
import { preflight } from './preflight.js';
import { generateAll } from './generate.js';
import { resolveNaming } from './naming.js';
import { resolveSpecs } from './resolve.js';
import type { BulkRow, CampaignBuildConfig, CampaignSpec } from './types.js';
import { planToRows } from './plan.js';
import { validateRows } from './validate.js';
import { buildCampaignUpdate, type CampaignUpdateChanges } from './update.js';
import { toUpdateBulkWorkbook } from './export.js';
import { readWorkbook, writeWorkbook } from './xlsx/index.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../../fixtures/golden/', import.meta.url));

interface GoldenFile<TCase> {
  schema: string;
  module: string;
  today: string;
  columns: string[];
  sheetName: string;
  cases: TCase[];
}

function loadGolden<TCase>(module: string): GoldenFile<TCase> {
  const file = JSON.parse(readFileSync(`${GOLDEN_DIR}${module}.json`, 'utf8')) as GoldenFile<TCase>;
  expect(file.schema).toBe('wizard-ads.parity.v1');
  expect(file.cases.length).toBeGreaterThan(0);
  return file;
}

/**
 * `JSON.parse(JSON.stringify(...))` first, so an `undefined` property and an
 * absent one compare the way the JSON golden represents them: identically.
 */
function expectParity(actual: unknown, expected: unknown): void {
  expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
}

interface GenerateCase {
  name: string;
  input: { config: CampaignBuildConfig; today: string };
  expected: {
    campaigns: unknown[];
    rows: BulkRow[];
    workbook: { sheetNames: string[]; header: string[]; rows: Array<Array<string | number>> };
    preflight: { ready: boolean; issues: string[]; notes: string[] };
    validate: { pass: boolean; fails: string[]; warns: string[] };
  };
}

describe('parity: campaign generation', () => {
  const golden = loadGolden<GenerateCase>('campaigns');

  it('pins the column contract the reference writes', () => {
    expect(golden.columns).toEqual([...SP_COLUMNS]);
    expect(golden.sheetName).toBe('Sponsored Products Campaigns');
  });

  for (const testCase of golden.cases) {
    const { config, today } = testCase.input;

    it(`${testCase.name}: campaigns`, () => {
      const naming = resolveNaming(config.naming);
      const campaigns = generateAll(resolveSpecs(config), naming, today);
      expectParity(campaigns, testCase.expected.campaigns);
    });

    it(`${testCase.name}: bulk rows`, () => {
      const rows = planToRows(buildCampaignPlan(config, { today }));
      expectParity(rows, testCase.expected.rows);
      // Verify the artifact, not the exit code: a projection that dropped rows
      // would still deep-equal a shorter expectation if only sampled.
      expect(rows.length).toBe(testCase.expected.rows.length);
    });

    it(`${testCase.name}: workbook round-trips to the Python reference file`, () => {
      const plan = buildCampaignPlan(config, { today });
      const written = readWorkbook(writeWorkbook(planToSheet(plan)));
      expect([written.sheetName]).toEqual(testCase.expected.workbook.sheetNames);
      expect(written.header).toEqual(testCase.expected.workbook.header);
      expectParity(written.rows, testCase.expected.workbook.rows);
      expect(written.rows.length).toBe(testCase.expected.workbook.rows.length);
    });

    it(`${testCase.name}: preflight`, () => {
      expectParity(preflight(config, today), testCase.expected.preflight);
    });

    it(`${testCase.name}: QA gates`, () => {
      const rows = planToRows(buildCampaignPlan(config, { today }));
      expectParity(validateRows(rows, today), testCase.expected.validate);
    });
  }

  it('covers every campaign type this engine generates', () => {
    const types = new Set<string>();
    for (const testCase of golden.cases) {
      for (const campaign of testCase.expected.campaigns as Array<{ campaignType: string }>) {
        types.add(campaign.campaignType);
      }
    }
    expect([...types].sort()).toEqual(['Auto', 'Halo', 'PAT', 'Phrase', 'SKW']);
  });

  it('generates no BMM campaign anywhere in the suite', () => {
    for (const testCase of golden.cases) {
      for (const campaign of testCase.expected.campaigns as Array<{ campaignType: string }>) {
        expect(campaign.campaignType).not.toBe('BMM');
      }
    }
  });

  it('leaves every generated campaign paused', () => {
    for (const testCase of golden.cases) {
      for (const row of testCase.expected.rows) {
        if (row.Entity === 'Campaign') expect(row.State).toBe('paused');
      }
    }
  });
});

interface PreflightCase {
  name: string;
  input: { config: CampaignBuildConfig; today: string };
  expected: { ready: boolean; issues: string[]; notes: string[] };
}

describe('parity: preflight', () => {
  const golden = loadGolden<PreflightCase>('campaign-preflight');
  for (const testCase of golden.cases) {
    it(testCase.name, () => {
      expectParity(preflight(testCase.input.config, testCase.input.today), testCase.expected);
    });
  }

  it('has cases on both sides of the ready line', () => {
    const ready = golden.cases.filter((c) => c.expected.ready);
    expect(ready.length).toBeGreaterThan(0);
    expect(golden.cases.length - ready.length).toBeGreaterThan(0);
  });
});

interface ValidateCase {
  name: string;
  input: { rows: BulkRow[]; today: string };
  expected: { pass: boolean; fails: string[]; warns: string[] };
}

describe('parity: QA gates', () => {
  const golden = loadGolden<ValidateCase>('campaign-validate');
  for (const testCase of golden.cases) {
    it(testCase.name, () => {
      expectParity(validateRows(testCase.input.rows, testCase.input.today), testCase.expected);
    });
  }

  it('includes a row set that must fail', () => {
    expect(golden.cases.some((c) => !c.expected.pass)).toBe(true);
  });
});

interface KeywordCase {
  name: string;
  input: { sections: KeywordSection[]; productName: string; sku: string[]; asin: string[] };
  expected: CampaignSpec[];
}

describe('parity: keyword sections to specs', () => {
  const golden = loadGolden<KeywordCase>('campaign-keywords');
  for (const testCase of golden.cases) {
    it(testCase.name, () => {
      const specs = specsFromSections(testCase.input.sections, {
        productName: testCase.input.productName,
        sku: testCase.input.sku,
        asin: testCase.input.asin,
      });
      expectParity(specs, testCase.expected);
    });
  }
});

interface UpdateCase {
  name: string;
  input: {
    entities: EntityRow[];
    changes: CampaignUpdateChanges;
    allowEndDateClear: boolean;
  };
  expected: {
    rows: BulkRow[];
    review: string[];
    errors: string[];
  };
}

describe('parity: campaign UPDATE mode', () => {
  const golden = loadGolden<UpdateCase>('campaign-update');

  it('pins the same Sponsored Products column contract as CREATE mode', () => {
    expect(golden.columns).toEqual([...SP_COLUMNS]);
  });

  for (const testCase of golden.cases) {
    it(`${testCase.name}: rows, review, and errors`, () => {
      const actual = buildCampaignUpdate(testCase.input.changes, testCase.input.entities, {
        allowEndDateClear: testCase.input.allowEndDateClear,
      });
      expectParity(actual.rows, testCase.expected.rows);
      // Several reference loops intentionally deduplicate through Python sets;
      // their order is hash-seed-dependent, while their contents are the
      // contract. Row order remains exact because Amazon consumes the sheet.
      expect([...actual.review].sort()).toEqual([...testCase.expected.review].sort());
      expect([...actual.errors].sort()).toEqual([...testCase.expected.errors].sort());
      expect(actual.rows).toHaveLength(testCase.expected.rows.length);
      expect(actual.review).toHaveLength(testCase.expected.review.length);
      expect(actual.errors).toHaveLength(testCase.expected.errors.length);
    });

    it(`${testCase.name}: workbook contains every reviewed output row`, () => {
      const actual = buildCampaignUpdate(testCase.input.changes, testCase.input.entities, {
        allowEndDateClear: testCase.input.allowEndDateClear,
      });
      const workbook = toUpdateBulkWorkbook(actual.rows, {
        client: 'Synthetic',
        marketplace: 'US',
        today: '2026-08-27',
      });
      const written = readWorkbook(workbook.bytes);
      expect(written.header).toEqual([...SP_COLUMNS]);
      expect(written.rows).toHaveLength(actual.rows.length);
      expectParity(
        written.rows,
        actual.rows.map((row) => SP_COLUMNS.map((column) => row[column])),
      );
    });
  }

  it('covers all three legal UPDATE-file operations', () => {
    const operations = new Set(
      golden.cases.flatMap((testCase) => testCase.expected.rows.map((row) => row.Operation)),
    );
    expect([...operations].sort()).toEqual(['Archive', 'Create', 'Update']);
  });
});
