import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpBidPreviewRequest } from '@wizard-ads/shared/mcp-writes';
import type { Sql } from './client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asServiceRole } from './testing/rls.js';
import { prepareMcpKeywordBidPreview } from './queries/mcp-write-preview.js';
import { issueMcpWriteDelegation } from './queries/mcp-writes.js';
import { loadSpWritePreviewEvidence } from './queries/sp-write-preview-evidence.js';

const available = await databaseAvailable();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON object');
  return value as JsonObject;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected JSON array');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected JSON string');
  return value;
}
function parse(value: string): JsonObject {
  const result: unknown = JSON.parse(value);
  return object(result);
}
interface Artifacts { request: JsonObject; source: JsonObject; plan: JsonObject; evidence: JsonObject }
interface RpcParams {
  orgId: string; keyId: string; tokenHash: string;
  requestText: string; requestPreimage: string; sourceText: string;
  planText: string; planPreimage: string; actionsText: string;
  evidenceText: string; guardrailPreimage: string; provenancePreimage: string;
}
function params(values: unknown[]): RpcParams {
  if (values.length !== 12) throw new Error('expected every producer RPC parameter');
  const v = values.map(text);
  return { orgId: v[0]!, keyId: v[1]!, tokenHash: v[2]!, requestText: v[3]!, requestPreimage: v[4]!,
    sourceText: v[5]!, planText: v[6]!, planPreimage: v[7]!, actionsText: v[8]!,
    evidenceText: v[9]!, guardrailPreimage: v[10]!, provenancePreimage: v[11]! };
}
function rawPrepare(sql: Sql, p: RpcParams) {
  return sql<{ plan_id: string }[]>`select app.prepare_mcp_bid_proposals_v1(
    ${p.orgId},${p.keyId},${p.tokenHash},${p.requestText},${p.requestPreimage},${p.sourceText},
    ${p.planText},${p.planPreimage},${p.actionsText}::jsonb,${p.evidenceText},${p.guardrailPreimage},${p.provenancePreimage}
  )::text as plan_id`;
}
function rehashPlan(p: RpcParams, plan: JsonObject): void {
  const { fingerprint: _fingerprint, ...body } = plan;
  p.planPreimage = JSON.stringify([plan['schemaVersion'], body]);
  plan['fingerprint'] = hash(p.planPreimage);
  p.planText = JSON.stringify(plan);
}
function pretty(value: string): string {
  const parsed: unknown = JSON.parse(value);
  return JSON.stringify(parsed, null, 2);
}

// These intentionally mutate unparsed JSON and recompute dependent hashes. A TS
// parser rejecting the payload would not prove the service SQL boundary rejects it.
describe.skipIf(!available)('MCP preview raw service SQL boundary', () => {
  let database: TestDatabase;
  let template: RpcParams;
  let profileId: string;
  beforeAll(async () => {
    database = await createTestDatabase('mcp_preview_sql_boundary');
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const copied = await database.sql`insert into public.keywords
      (org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
      select org_id,profile_id,'kw-2',ad_product,'Synthetic second keyword',state,campaign_id,ad_group_id,
        'synthetic second keyword',match_type,bid from public.keywords
      where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'kw-1' returning amazon_id`;
    expect(copied).toHaveLength(1);
    const versionId = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${versionId},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${versionId}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const tokenHash = hash(randomUUID());
    const delegation = await issueMcpWriteDelegation(database, { orgId, userId }, {
      label: 'Synthetic raw SQL boundary', profileIds: [profileId], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      limits: { action: 'keyword.bid', maximumRowsPerCall: 2, maximumRowsPerUtcDay: 3,
        maximumAbsoluteDeltaByCurrency: [{ amount: '0.2', currencyCode: 'USD' }], maximumRelativeDelta: '0.25' },
    }, { tokenHash, keyPrefix: 'wza_syntheti' });
    const request: McpBidPreviewRequest = { requestId: randomUUID(), profileId, source: { kind: 'keyword_proposals',
      note: 'Synthetic SQL boundary', rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8' }] } };
    let captured: RpcParams | undefined;
    await asServiceRole(database, async (sql) => {
      const capture = new Proxy(sql, {
        apply(target, thisArg: unknown, argumentsList: unknown[]) {
          const fragments = argumentsList[0];
          if (Array.isArray(fragments) && fragments.every((part) => typeof part === 'string')
            && fragments.join(' ').includes('app.prepare_mcp_bid_proposals_v1(')) {
            captured = params(argumentsList.slice(1));
            throw new Error('capture producer parameters before SQL mutation');
          }
          return Reflect.apply(target, thisArg, argumentsList);
        },
      });
      await expect(prepareMcpKeywordBidPreview({ sql: capture }, { orgId, keyId: delegation.keyId, tokenHash }, request))
        .rejects.toMatchObject({ code: 'outcome_unknown' });
    });
    if (!captured) throw new Error('producer never reached its source-recording RPC');
    template = captured;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  function fresh(twoRows = false): Artifacts {
    const result: Artifacts = { request: parse(template.requestText), source: parse(template.sourceText),
      plan: parse(template.planText), evidence: parse(template.evidenceText) };
    const requestId = randomUUID(); const batchId = randomUUID(); const planId = randomUUID(); const rowId = randomUUID();
    result.request['requestId'] = requestId;
    Object.assign(result.source, { requestId, applyBatchId: batchId });
    object(array(result.source['rows'])[0])['applyRowId'] = rowId;
    result.plan['id'] = planId;
    object(result.plan['source'])['applyBatchId'] = batchId;
    const action = object(array(result.plan['actions'])[0]);
    action['actionId'] = randomUUID();
    object(array(action['sources'])[0])['applyRowId'] = rowId;
    result.evidence['planId'] = planId;
    object(result.evidence['provenance'])['applyBatchId'] = batchId;
    if (twoRows) {
      const secondRowId = randomUUID();
      const requestSource = object(result.request['source']);
      requestSource['rows'] = [{ ...object(array(requestSource['rows'])[0]), keywordId: 'kw-2' }, ...array(requestSource['rows'])];
      result.source['rows'] = [{ ...object(array(result.source['rows'])[0]), keywordId: 'kw-2', applyRowId: secondRowId },
        ...array(result.source['rows'])];
      const secondAction = structuredClone(action);
      secondAction['actionId'] = randomUUID();
      object(secondAction['entity'])['keywordId'] = 'kw-2';
      object(array(secondAction['sources'])[0])['applyRowId'] = secondRowId;
      result.plan['actions'] = [secondAction, action];
      const counts = object(result.plan['counts']);
      Object.assign(counts, { logicalChanges: 2, providerRows: 2, uniqueEntities: 2 });
      object(counts['byRoute'])['sp.v3.keywords.update'] = 2;
    }
    return result;
  }
  function rebuild(b: Artifacts): RpcParams {
    const provenance = object(b.evidence['provenance']);
    provenance['artifactText'] = JSON.stringify(b.source);
    provenance['artifactSha256'] = hash(text(provenance['artifactText']));
    provenance['rows'] = structuredClone(b.source['rows']);
    const guardrailPreimage = JSON.stringify(['openspell.sp-write-preview-guards.v2', b.evidence['guardrails']]);
    const provenancePreimage = JSON.stringify(['openspell.sp-write-preview-source.v2', provenance]);
    Object.assign(object(b.plan['source']), {
      guardrailSnapshotFingerprint: hash(guardrailPreimage), provenanceSnapshotFingerprint: hash(provenancePreimage),
    });
    const actions = array(b.plan['actions']).map((rawAction) => {
      const action = object(rawAction); const { fingerprint: _fingerprint, ...body } = action;
      const fingerprintPreimage = JSON.stringify(['openspell.sp-write-action.v1', body]);
      action['fingerprint'] = hash(fingerprintPreimage);
      return { artifactText: JSON.stringify(action), fingerprintPreimage };
    });
    const result = { ...template, requestText: JSON.stringify(b.request),
      requestPreimage: JSON.stringify(['openspell.mcp-bid-preview-request.v1', b.request]),
      sourceText: JSON.stringify(b.source), actionsText: JSON.stringify(actions), evidenceText: JSON.stringify(b.evidence),
      guardrailPreimage, provenancePreimage };
    rehashPlan(result, b.plan);
    return result;
  }
  async function counts() {
    const orgId = template.orgId;
    const [row] = await database.sql<Record<string, number>[]>`select
      (select count(*)::int from mcp.write_previews where org_id = ${orgId}) as previews,
      (select count(*)::int from mcp.bid_proposal_sources where org_id = ${orgId}) as sources,
      (select count(*)::int from public.apply_batches where org_id = ${orgId}) as batches,
      (select count(*)::int from public.apply_rows where org_id = ${orgId}) as rows,
      (select count(*)::int from public.sp_write_plans where org_id = ${orgId}) as plans,
      (select count(*)::int from public.sp_write_plan_actions where org_id = ${orgId}) as actions,
      (select count(*)::int from public.sp_write_preview_evidence where org_id = ${orgId}) as evidence,
      (select count(*)::int from public.audit_log where org_id = ${orgId} and action = 'mcp.bid_preview.prepared') as audits,
      (select count(*)::int from public.sp_write_authorization_receipts where org_id = ${orgId}) as approvals,
      (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as outbox`;
    if (!row) throw new Error('missing source counts');
    return row;
  }
  async function refused(p: RpcParams) {
    const before = await counts();
    await expect(asServiceRole(database, (sql) => rawPrepare(sql, p))).rejects.toHaveProperty('code');
    expect(await counts()).toEqual(before);
  }

  it('accepts a rehashed raw reference, reloads it, and replays without duplicating any output', async () => {
    const b = fresh(); const p = rebuild(b); const before = await counts();
    const saved = await asServiceRole(database, (sql) => rawPrepare(sql, p));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.plan_id).toBe(b.plan['id']);
    const after = await counts();
    expect(after).toEqual(Object.fromEntries(Object.entries(before).map(([key, count]) =>
      [key, count + (['approvals', 'outbox'].includes(key) ? 0 : 1)])));
    const loaded = await loadSpWritePreviewEvidence(database.sql, { orgId: template.orgId, profileId, planId: saved[0]!.plan_id });
    expect(loaded?.plan).toEqual(parse(p.planText));
    expect(loaded?.evidence).toEqual(parse(p.evidenceText));
    expect(await asServiceRole(database, (sql) => rawPrepare(sql, p))).toEqual(saved);
    expect(await counts()).toEqual(after);
  });

  it.each([
    ['tab-only', '\t'], ['newline-only', '\n'], ['NBSP-only', '\u00a0'], ['BOM-only', '\ufeff'],
    ['leading tab', '\ttext'], ['trailing line separator', 'text\u2028'],
    ['1002 UTF-16 units', '😀'.repeat(501)],
  ])('refuses raw notes outside the shared contract: %s', async (_name, note) => {
    const b = fresh(); object(b.request['source'])['note'] = note; b.source['note'] = note;
    await refused(rebuild(b));
  });

  it('accepts the recorded two-row sequence and refuses a rehashed permutation with no residue', async () => {
    const b = fresh(true); const p = rebuild(b); const before = await counts();
    const saved = await asServiceRole(database, (sql) => rawPrepare(sql, p));
    expect(saved).toHaveLength(1);
    const loaded = await loadSpWritePreviewEvidence(database.sql, { orgId: template.orgId, profileId, planId: saved[0]!.plan_id });
    expect(loaded?.plan.actions.map((action) => action.entity)).toEqual([{ keywordId: 'kw-2' }, { keywordId: 'kw-1' }]);
    expect(await counts()).toEqual(Object.fromEntries(Object.entries(before).map(([key, count]) =>
      [key, count + (['approvals', 'outbox'].includes(key) ? 0 : ['rows', 'actions'].includes(key) ? 2 : 1)])));
    const reordered = fresh(true);
    reordered.plan['actions'] = [...array(reordered.plan['actions'])].reverse();
    await refused(rebuild(reordered));
    const downgraded = fresh(); downgraded.plan['schemaVersion'] = 'openspell.sp-write-plan.v1';
    await refused(rebuild(downgraded));
  });

  it('enforces v2 source and inverse sequence at the direct service recorder', async () => {
    const b = fresh(true); const prepared = rebuild(b);
    await asServiceRole(database, (sql) => rawPrepare(sql, prepared));
    function record(plan: JsonObject) {
      const p = { ...template };
      const proofs = array(plan['actions']).map((raw) => {
        const action = object(raw); const { fingerprint: _fingerprint, ...body } = action;
        const fingerprintPreimage = JSON.stringify(['openspell.sp-write-action.v1', body]);
        action['fingerprint'] = hash(fingerprintPreimage);
        return { artifactText: JSON.stringify(action), fingerprintPreimage };
      });
      rehashPlan(p, plan);
      return asServiceRole(database, (sql) => sql`select app.record_sp_write_plan(
        ${p.planText},${p.planPreimage},${JSON.stringify(proofs)}::jsonb)`);
    }
    function inverse() {
      const plan = structuredClone(b.plan);
      Object.assign(plan, { id: randomUUID(), direction: 'inverse', source: {
        kind: 'inverse_execution', sourceExecutionId: randomUUID(), sourcePlanId: b.plan['id'],
        sourcePlanFingerprint: b.plan['fingerprint'],
      } });
      plan['actions'] = array(b.plan['actions']).map((raw) => {
        const forward = object(raw); const action = structuredClone(forward);
        action['actionId'] = randomUUID();
        action['sources'] = [{ kind: 'inverse_action', sourceActionId: forward['actionId'], changeKey: 'keyword.bid' }];
        const bid = object(object(action['changes'])['bid']);
        [bid['expected'], bid['requested']] = [bid['requested'], bid['expected']];
        return action;
      });
      return plan;
    }
    const before = await counts();
    const valid = inverse();
    expect(await record(valid)).toHaveLength(1);
    expect(await counts()).toEqual({ ...before, plans: before['plans']! + 1, actions: before['actions']! + 2 });
    const cases: [string, JsonObject][] = [];
    const wrongOrder = inverse(); wrongOrder['actions'] = [...array(wrongOrder['actions'])].reverse();
    cases.push(['inverse permutation', wrongOrder]);
    const downgrade = inverse(); downgrade['schemaVersion'] = 'openspell.sp-write-plan.v1';
    cases.push(['version downgrade', downgrade]);
    const wrongSwap = inverse();
    object(object(object(array(wrongSwap['actions'])[0])['changes'])['bid'])['requested'] = { amount: '0.85', currencyCode: 'USD' };
    cases.push(['inexact inverse', wrongSwap]);
    const submillisecond = inverse();
    const instant = text(submillisecond['generatedAt']).replace(/[.]\d{3}Z$/, '.000000Z');
    Object.assign(submillisecond, { generatedAt: instant, frozenAt: instant, expiresAt: instant.replace('.000000Z', '.000001Z') });
    cases.push(['submillisecond validity window', submillisecond]);
    const rounded = inverse();
    rounded['expiresAt'] = text(rounded['expiresAt']).replace(/[.]\d+Z$/, '.0009999Z');
    cases.push(['precision beyond database microseconds', rounded]);
    const missingSource = structuredClone(b.plan); missingSource['id'] = randomUUID();
    cases.push(['unowned forward source', missingSource]);
    const forwardOrder = structuredClone(b.plan); forwardOrder['actions'] = [...array(forwardOrder['actions'])].reverse();
    cases.push(['forward permutation', forwardOrder]);
    for (const [name, plan] of cases) {
      const baseline = await counts();
      await expect(record(plan), name).rejects.toMatchObject({ code: '22023' });
      expect(await counts(), name).toEqual(baseline);
    }
  });

  it.each(['request', 'guardrail', 'provenance', 'plan', 'action'] as const)(
    'refuses a semantically equal but noncanonical %s fingerprint preimage', async (kind) => {
      const p = rebuild(fresh());
      if (kind === 'request') p.requestPreimage = pretty(p.requestPreimage);
      if (kind === 'guardrail' || kind === 'provenance') {
        const plan = parse(p.planText);
        if (kind === 'guardrail') {
          p.guardrailPreimage = pretty(p.guardrailPreimage);
          object(plan['source'])['guardrailSnapshotFingerprint'] = hash(p.guardrailPreimage);
        } else {
          p.provenancePreimage = pretty(p.provenancePreimage);
          object(plan['source'])['provenanceSnapshotFingerprint'] = hash(p.provenancePreimage);
        }
        rehashPlan(p, plan);
      }
      if (kind === 'plan') {
        const plan = parse(p.planText); p.planPreimage = pretty(p.planPreimage);
        plan['fingerprint'] = hash(p.planPreimage); p.planText = JSON.stringify(plan);
      }
      if (kind === 'action') {
        const parsed: unknown = JSON.parse(p.actionsText); const entries = array(parsed);
        const proof = object(entries[0]); const action = parse(text(proof['artifactText']));
        proof['fingerprintPreimage'] = pretty(text(proof['fingerprintPreimage']));
        action['fingerprint'] = hash(text(proof['fingerprintPreimage']));
        proof['artifactText'] = JSON.stringify(action); p.actionsText = JSON.stringify(entries);
        const plan = parse(p.planText); array(plan['actions'])[0] = action; rehashPlan(p, plan);
      }
      await refused(p);
    },
  );

  const malformed: [string, (b: Artifacts) => void][] = [
    ['missing route counts', (b) => { delete object(b.plan['counts'])['byRoute']; }],
    ['incomplete route counts', (b) => { object(b.plan['counts'])['byRoute'] = { 'sp.v3.keywords.update': 1 }; }],
    ['numeric-string provider count', (b) => { object(b.plan['counts'])['providerRows'] = '1'; }],
    ['unknown count field', (b) => { object(b.plan['counts'])['extra'] = 1; }],
    ['numeric-string route count', (b) => { object(object(b.plan['counts'])['byRoute'])['sp.v3.keywords.update'] = '1'; }],
    ['unknown entity field', (b) => { object(object(array(b.plan['actions'])[0])['entity'])['extra'] = 'unused'; }],
    ['unknown money field', (b) => {
      object(object(object(object(array(b.plan['actions'])[0])['changes'])['bid'])['expected'])['extra'] = 'unused';
    }],
    ['non-ISO matching timestamps', (b) => {
      const preparedAt = text(b.source['preparedAt']).replace('T', ' ');
      b.source['preparedAt'] = preparedAt; b.plan['generatedAt'] = preparedAt; b.plan['frozenAt'] = preparedAt;
      object(b.evidence['provenance'])['preparedAt'] = preparedAt;
    }],
    ['non-ISO expiry', (b) => { b.plan['expiresAt'] = text(b.plan['expiresAt']).replace('T', ' '); }],
    ['leap-second expiry', (b) => { b.plan['expiresAt'] = text(b.plan['expiresAt']).replace(/:[0-5][0-9]([.]\d+)?Z$/, ':60.000Z'); }],
  ];
  it.each(malformed)('refuses a rehashed nested contract violation: %s', async (_name, mutate) => {
    const b = fresh(); mutate(b); await refused(rebuild(b));
  });
});
