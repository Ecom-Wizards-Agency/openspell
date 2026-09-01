# WP-184 distinctive release evidence architecture

Status: synthesized 2026-09-01. The operator requested uninterrupted goal-mode continuation, so
the committed design is the architecture checkpoint and implementation may follow without a
separate pause.

## Problem

The immutable-candidate verifier on current main proves a full Git revision, authenticated route
health, complete Grid cardinality, and closed timing spans. It still accepts an explicit revision
override ahead of Vercel's build metadata, identifies several pages by generic headings, does not
verify the deployed official SVG bytes or response media type, and prints account-derived counts,
response sizes, and timings. The replacement must strengthen those assertions without restoring
PR #35's stale transport, forwarding cookies to public assets, turning evidence into promotion
authority, or performing a deployment.

## Usage from the caller's view

The operator still supplies one immutable Vercel candidate and one full Git object id:

```bash
bash apps/web/scripts/verify-release-candidate.sh \
  https://<immutable-candidate>.vercel.app \
  <full-git-object-id>
```

Exit zero means the fixed policy passed. Standard output contains one sanitized evidence document:

```json
{
  "schema": "openspell.release-evidence/v1",
  "purpose": "verification-only",
  "authorization": "none",
  "verdict": "pass",
  "candidateOriginSha256": "sha256:<64 lowercase hex>",
  "revision": {
    "expected": "<full-git-object-id>",
    "observed": "<full-git-object-id>",
    "source": "vercel"
  },
  "checks": [
    { "id": "hosted-revision", "verdict": "pass" },
    { "id": "official-brand-svg", "verdict": "pass" },
    { "id": "authenticated-routes", "verdict": "pass" },
    { "id": "campaign-grid", "verdict": "pass" },
    { "id": "recommendation-review", "verdict": "pass" },
    { "id": "complete-grid-rows", "verdict": "pass" }
  ]
}
```

The document contains no candidate hostname, URL, cookie, profile id, account label, response
body, row count, response size, raw timing, or provider identifier. A failed check uses a fixed
reason code and public artifact ids only. An exception that prevents evidence construction retains
the existing fixed `OPENSPELL_RELEASE_ERROR:<code>` form.

The evidence does not move an alias:

```text
verify immutable candidate -> inspect evidence -> separate operator promotion decision
```

There is no evidence-to-promotion conversion and no deployment provider mutation import.

## Shape

### Authoritative build identity

`apps/web/src/revision.ts` owns hosted versus local revision resolution:

```ts
export type WebRevisionSource = 'vercel' | 'explicit' | 'unknown';

export interface WebRevisionIdentity {
  readonly revision: string;
  readonly source: WebRevisionSource;
}

export function resolveWebRevisionIdentity(
  env?: Readonly<Record<string, string | undefined>>,
): WebRevisionIdentity {
  throw new Error('not implemented');
}
```

A valid `VERCEL_GIT_COMMIT_SHA` is authoritative. An explicit value may be absent or exactly equal.
A present malformed Vercel value, a malformed explicit value, or a disagreement returns
`{ revision: 'unknown', source: 'unknown' }`. When Vercel metadata is absent, one valid explicit
value remains available for local development with source `explicit`. `/api/healthz` publishes the
non-secret source discriminator. An immutable Vercel candidate passes only with source `vercel`.

### Bound public identity and rendered capabilities

`apps/web/src/release/candidate-artifacts.ts` owns the frozen evidence policy. Its two public
operations reflect the credential boundary rather than incidental execution stages:

```ts
declare const revisionBound: unique symbol;

export interface RevisionBoundCandidate {
  readonly origin: string;
  readonly expectedRevision: string;
  readonly [revisionBound]: true;
}

export type CandidateCheckId =
  | 'hosted-revision'
  | 'official-brand-svg'
  | 'authenticated-routes'
  | 'campaign-grid'
  | 'recommendation-review'
  | 'complete-grid-rows';

export interface CandidateCheckResult {
  readonly id: CandidateCheckId;
  readonly verdict: 'pass' | 'fail' | 'not-run';
  readonly reason?: CandidateFailureReason;
  readonly missingArtifacts?: readonly CandidateArtifactId[];
}

export async function verifyPublicCandidateIdentity(input: {
  readonly candidate: URL;
  readonly expectedRevision: string;
  readonly request: (url: URL) => Promise<CandidateHttpResponse>;
}): Promise<
  | {
      readonly passed: true;
      readonly candidate: RevisionBoundCandidate;
      readonly revision: ObservedCandidateRevision;
      readonly checks: readonly CandidateCheckResult[];
    }
  | {
      readonly passed: false;
      readonly candidate: null;
      readonly revision: ObservedCandidateRevision;
      readonly checks: readonly CandidateCheckResult[];
    }
> {
  throw new Error('not implemented');
}

export async function verifyBoundCandidateCapabilities(input: {
  readonly candidate: RevisionBoundCandidate;
  readonly expectedProfileId: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly request: (url: URL) => Promise<CandidateHttpResponse>;
}): Promise<readonly CandidateCheckResult[]> {
  throw new Error('not implemented');
}
```

The first operation sends no cookies. It requires an exact 200 JSON health response, no redirect,
an exact effective URL, product and readiness fields, a Vercel-authoritative full revision, then an
exact 200 official SVG with no redirect, exact effective URL, exact `image/svg+xml` media type, and
raw-body SHA-256:

```text
ec87eb73689b1792fabd9c7098b03f7b7c86f4192ced9c9ad63a64ab85ed0a55
```

Only that conjunction registers a frozen, string-backed `RevisionBoundCandidate` in a private
runtime capability set. A fabricated object, copied object, mutable `URL`, or malformed expected
revision cannot enter the authenticated operation. That operation owns the route list, serial
execution, redirect policy integration, DOM assertions, Grid request, and fixed diagnostics.

The Campaign Grid request is exactly `/grid?entity=campaigns` plus the selected profile and an
explicit complete reporting window. Its parsed server document must contain an authenticated app
shell and:

- the real `Campaigns` heading;
- the `Active advertising account and reporting window` region with a nonempty account value;
- the real date-range component, inside that account context, with matching `from` and `to` values;
- the versioned official-brand marker on the real brand-link element.

The Recommendations document must contain its heading and the versioned focused-review marker on
its `main` element for every authenticated data state. An error or login document never carries the marker. Existing
Playwright coverage proves the marked successful state also renders and operates the real
`ReviewWorkspace`; the marker is identity, not a substitute implementation.

All server documents are parsed as inert DOM. Comments, scripts, serialized error data, and plain
text occurrences do not satisfy element assertions. Existing error, login, no-profile, database,
app-shell, final-path, and exact-profile guards remain conjunctive.

The Grid rows request uses the same campaign entity, profile, and date window. The verifier still
requires an HTTP 200, safe exact `rowCount === rows.length`, `truncated === false`, and the complete
closed timing grammar. It reduces the private values to one pass/fail result before output.

### Transport evidence

`CandidateHttpResponse` adds only closed internal evidence:

```ts
export type CandidateMediaType =
  | 'application/json'
  | 'text/html'
  | 'image/svg+xml'
  | 'other'
  | 'missing';

export interface CandidateHttpResponse {
  readonly status: number | null;
  readonly responseBody: string;
  readonly responseBodySha256: string;
  readonly rawLocation: string | null;
  readonly mediaType: CandidateMediaType;
  readonly effectiveUrlMatched: boolean;
  readonly serverTiming: GridServerTimingDurations | null;
}
```

`candidate-transport.ts` remains one bounded GET-only `vercel curl` subprocess. Candidate host and
path stay in fixed arguments; query and cookies stay in stdin configuration; redirects stay under
manual policy; stderr is counted but never replayed. The parser hashes raw body bytes before UTF-8
decoding, requires exactly one of each policy-bearing response header, reduces content type and
Grid timing to closed values, and compares curl's effective URL to the exact requested URL.
Duplicate or conflicting Content-Type, Location, or Server-Timing headers fail before reduction.
Arbitrary headers and effective URLs never leave the transport.

Each call runs from a fresh mode-0700 directory under the fixed Unix temporary root, with an empty
`.vercel/repo.json` at that exact directory and child temp variables pinned there. The empty file
terminates the reviewed repository-first lookup before any ancestor project link can be used.
Cleanup is mandatory. Vercel CLI 59.5.0 is an exact web development dependency whose registry
integrity is recorded in `pnpm-lock.yaml`. The launcher resolves that package's local manifest and
entry point, validates its name, version, and bin mapping, and invokes it through the current
absolute Node executable. It neither searches `PATH` for Vercel nor executes the CLI shebang. The
native CLI trampoline is disabled. The CLI receives only the verified root-owned, non-writable
system directory containing `/usr/bin/curl` as `PATH`; writable and caller-provided directories are
excluded. Together with the repository boundary, these constraints stop inherited executable or
project state from granting provider-write authority. The child environment otherwise keeps only
the Vercel CLI context, required filesystem locations, locale, and time zone. Proxy and custom-CA
variables do not cross into the child that receives the cookie header.

Session cookies come only from the fixed HTTPS production origin. The verifier accepts the
application's current non-Secure cookie shape but requires the exact host-only production domain,
root path, one valid Supabase auth chunk family, bounded unique names and values, and an optional
UUID org selector. It forwards them only to the validated HTTPS candidate. CDP remains restricted
to an uncredentialed loopback endpoint with no query or fragment.

### Public evidence projection

`apps/web/src/release/release-evidence.ts` is the only report constructor:

```ts
export interface PublicReleaseEvidenceV1 {
  readonly schema: 'openspell.release-evidence/v1';
  readonly purpose: 'verification-only';
  readonly authorization: 'none';
  readonly verdict: 'pass' | 'fail';
  readonly candidateOriginSha256: `sha256:${string}`;
  readonly revision: {
    readonly expected: string;
    readonly observed: string;
    readonly source: WebRevisionSource;
  };
  readonly checks: readonly PublicCandidateCheck[];
}

export function serializeReleaseEvidence(input: {
  readonly candidate: URL;
  readonly expectedRevision: string;
  readonly observedRevision: ObservedCandidateRevision;
  readonly checks: readonly CandidateCheckResult[];
}): string {
  throw new Error('not implemented');
}
```

The candidate commitment is
`SHA256("openspell.release-candidate-origin.v1\0" + candidate.origin)`. Fixed policy order makes
serialization deterministic. The report omits timestamps because CI or artifact-store metadata
already records run time and a timestamp would prevent byte comparison. The digest avoids routine
hostname disclosure, but it is not a secret or an authenticated signature.

### Module map

- `src/revision.ts`: build-revision authority and source.
- `app/api/healthz/route.ts`: public liveness plus sanitized revision identity.
- `src/ui/artifact-markers.ts`: client-safe versioned marker constants.
- `src/ui/profile-aware-brand.tsx`: marker on the existing real brand element.
- `app/recommendations/page.tsx`: marker on authenticated non-error data states.
- `src/release/candidate-transport.ts`: bounded GET subprocess and closed response evidence.
- `src/release/candidate-redirect.ts`: existing one-hop same-origin exact-profile redirect policy.
- `src/release/candidate-artifacts.ts`: public binding and authenticated capability policy.
- `src/release/release-evidence.ts`: privacy projection and deterministic serialization.
- `scripts/verify-release-candidate.ts`: input/session shell and sequencing only.

No shared contract, database, migration, worker, Amazon client, deployment configuration, or
provider mutation module changes.

## Synthesis decision

Candidate A is the base because one injected capability module hides route selection, marker
policy, exact asset identity, and sanitized failures behind two credential-aware operations. Its
unchanged verbose report was rejected.

Candidate C contributes deterministic, versioned, privacy-safe evidence, an origin commitment,
and the revision-source discriminator. Its policy digest, whole-receipt digest, strict canonical
receipt verifier, and persistence workflow were rejected. They add public concepts without adding
authenticity or satisfying a current consumer.

Candidate B contributes Vercel-authoritative revision conflict handling, exact media/effective-URL
binding, inert DOM inspection, proxy and custom-CA removal, loopback-only CDP, and explicit
non-authorizing evidence. Its nonce, private evidence chain, final revision fence, Merkle-like
roots, and eight-module split were rejected. The immutable host and fixed checks do not need those
extra mechanisms.

PR #35 contributes only the still-distinct exact SVG, Grid context/date/brand, and Recommendations
identity requirements. Current main's later GET-only transport, revision-first cookie boundary,
manual redirect validation, serial route sweep, and Grid completeness proof remain authoritative.

## Tradeoffs accepted

- We accept versioned invisible DOM markers in exchange for data-independent release identity.
- We accept deliberate SVG hash maintenance in exchange for exact deployed-byte proof.
- We accept stricter local networking requirements in exchange for not forwarding production
  cookies through inherited proxies, custom trust stores, or remote CDP endpoints.
- We accept server-rendered DOM proof in exchange for a bounded verifier. Playwright remains the
  separate authority for hydration and interaction.
- We accept an unsigned origin digest in exchange for no signing secret or false authority claim.
- We retain private counts and timings only long enough to verify equality and completeness, then
  reduce them to a boolean so evidence is safe to retain.

## Alternatives considered

- Rebase or cherry-pick PR #35. Rejected because its head is stale and conflicting and would
  replace newer transport, redirect, serialization, and Grid evidence work.
- Add the assertions inline to `verify-release-candidate.ts`. Rejected because the caller would
  own route policy, asset hashes, DOM inspection, and privacy projection.
- Use a browser or screenshots as the primary candidate verifier. Rejected because it weakens
  exact status, media-type, raw-byte, redirect, and bounded-output assertions. Browser QA remains a
  later release gate.
- Issue a signed or content-addressed promotion receipt. Rejected because WP-184 has no approved
  signer, evidence store, or promotion consumer, and evidence must not acquire deployment authority.

## Red-flag screen

- Shallow module: passed. Two operations hide the full public and authenticated check policies.
- Information leakage: passed if only `release-evidence.ts` serializes results and raw response
  fields stay internal.
- Temporal decomposition: passed. The two operations exist because cookie authority changes, not
  because the code happens to run in two steps.
- Pass-through methods: passed. Public verification creates a capability that the authenticated
  operation requires; neither method merely forwards arguments.

Scrap the design if implementation needs marker literals in more than one module, capability-
specific branches in the CLI, a raw URL plus cookie escape hatch outside the existing transport,
uncollected `.test.tsx` coverage, or more than one public evidence constructor.

## Open questions and risks

- A hashed Vercel hostname avoids routine disclosure but cannot hide an enumerable hostname from
  someone who already has likely candidates.
- Corporate environments that require an outbound proxy or custom CA will now fail closed. A
  future proxy policy needs separate review rather than inheriting ambient variables.
- DOM proof confirms server-rendered capability identity, not client hydration. Exact-head
  Playwright and attended candidate QA remain required before promotion.
- Revision disagreement may expose a stale deployment configuration that previously appeared
  healthy. That failure is intentional and must be fixed in deployment configuration, not bypassed.

## Acceptance proofs

- Vercel metadata wins only when valid; a conflicting or malformed explicit value fails closed.
- `/api/healthz` publishes `revisionSource`, and release evidence accepts only `vercel`.
- The real tracked SVG passes only with status 200, no redirect, exact effective URL, exact SVG
  media type, and the recorded raw-body hash. One changed byte, 3xx, HTML, or a parameterized SVG
  type fails.
- `/grid?entity=campaigns` requires Campaigns, nonempty active-account context, the real date-range
  component with exact requested values, and the versioned real-brand element.
- Recommendations without its versioned review identity fails even when the heading exists.
- Error markup containing marker text in scripts, comments, or an alert fails DOM inspection.
- Route and Grid requests remain serial; exact profile and query values survive the existing
  redirect policy.
- Grid cardinality mismatch, truncation, malformed JSON, unsafe counts, or incomplete timing fails.
- Public output omits synthetic canary hostnames, cookies, profile ids, account labels, response
  bodies, counts, sizes, and timings. Changing only those private measurements does not change a
  passing evidence document.
- The child receives no proxy, custom-CA, database, Amazon, diagnostic, preload, bypass-secret, or
  unrelated OpenSpell environment values.
- The integrity-locked Vercel package runs through the current absolute Node executable, ignores
  an injected `PATH` executable, disables its native trampoline, and exposes only the verified
  root-owned system path needed for curl. It runs behind the exact-cwd empty repository boundary,
  cannot resolve an inherited project link, and cannot create provider state. Cleanup is proved
  after success and failure.
- Auth, organization, and profile cookies require the exact production host and root path before
  forwarding; parent-domain and narrower-path cookies fail closed.
- Duplicate policy headers, fabricated capabilities, and unvalidated public evidence values fail.
- Remote or credentialed CDP endpoints fail before browser connection.
- Every new Vitest file ends in `.test.ts`; the brand source test proves its marker, CSS asset path,
  and real tracked SVG digest.
- Focused tests, web typecheck, production build, full `pnpm check`, diff check, staged hygiene,
  exact-head CI, and exact-main CI pass.
- Implementation and tests perform no deployment, promotion, migration, database mutation,
  provider write, or Amazon call.
