import { describe, expect, it } from 'vitest';
import {
  SpWritePreviewEvidence,
  serializeSpWritePreviewGuardrails,
  serializeSpWritePreviewProvenance,
} from './sp-write-preview-evidence.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

function fixture() {
  const row = { applyRowId: id('5'), recommendationId: id('6'), runId: id('7') };
  return SpWritePreviewEvidence.parse({
    schemaVersion: 'openspell.sp-write-preview-evidence.v1', planId: id('1'),
    guardrails: {
      profileGrantId: id('2'), profileGrantVersion: id('3'),
      providerScope: { amazonProfileId: 'synthetic-profile', connectionId: id('4'), region: 'NA',
        marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' },
      maximumProviderRows: 500, requireCurrentValueMatch: true,
      policies: [{ ...row, strategySnapshotText: JSON.stringify({
        schema: 'wizard-ads.tenant-strategy.v1', pacing: {}, opt_groups: {}, rank_lifecycle: {},
        staged_apply: {}, bids: {}, sv_bands: {}, caps: {}, pat_split: {}, naming: {},
      }), strategyGoal: 'neutral', groupId: null, groupSnapshotText: null }],
    },
    provenance: { applyBatchId: id('8'), artifactText: '[{"entity_type":"keyword","entity_id":"kw-1","field":"bid","old":"0.9","new":"0.7"}]\n', artifactSha256: 'a'.repeat(64),
      exportedAt: '2026-09-05T12:00:00.000Z', tag: 'synthetic', optGroup: 'synthetic',
      lever: 'bid-down', note: 'Synthetic snapshot', rows: [row] },
  });
}

describe('frozen SP preview evidence', () => {
  it('changes guardrail preimages when the grant version or recorded goal changes', () => {
    const evidence = fixture();
    const before = serializeSpWritePreviewGuardrails(evidence);
    expect(serializeSpWritePreviewGuardrails({ ...evidence, guardrails: {
      ...evidence.guardrails, profileGrantVersion: id('99'),
    } })).not.toBe(before);
    const policy = evidence.guardrails.policies[0]!;
    expect(serializeSpWritePreviewGuardrails({ ...evidence, guardrails: {
      ...evidence.guardrails, policies: [{ ...policy, strategyGoal: 'scale' }],
    } })).not.toBe(before);
  });

  it('refuses missing policy evidence and mismatched source-row ownership', () => {
    const evidence = fixture();
    expect(SpWritePreviewEvidence.safeParse({ ...evidence, guardrails: {
      ...evidence.guardrails, policies: [],
    } }).success).toBe(false);
    expect(SpWritePreviewEvidence.safeParse({ ...evidence, provenance: {
      ...evidence.provenance, rows: [{ ...evidence.provenance.rows[0], recommendationId: id('99') }],
    } }).success).toBe(false);
    expect(SpWritePreviewEvidence.safeParse({ ...evidence, guardrails: {
      ...evidence.guardrails, policies: [{ ...evidence.guardrails.policies[0], strategySnapshotText: null }],
    } }).success).toBe(false);
  });

  it('freezes artifact bytes and source identities in the provenance preimage', () => {
    const evidence = fixture();
    expect(serializeSpWritePreviewProvenance({ ...evidence, provenance: {
      ...evidence.provenance, artifactText: evidence.provenance.artifactText.replace('0.7', '0.6'),
    } })).not.toBe(serializeSpWritePreviewProvenance(evidence));
  });
});
