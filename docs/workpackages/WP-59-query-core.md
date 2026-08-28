# WP-59 — Query Intelligence Core

## Scope

This package supplies the pure, deterministic Query Intelligence behavior used
by later SQP ingestion, review and presentation work. It performs no I/O and
cannot write to Amazon.

Implemented in `packages/core/src/query-intelligence/`:

- Unicode-, punctuation- and case-stable query normalization without stemming;
- contiguous token-boundary vocabulary matching, including explicit aliases and
  ASINs, without short-token substring matches;
- the shared six-category taxonomy and presentation labels;
- approved-vocabulary precedence and a `Needs Review` state for unapproved
  suggestions;
- Sponsored Brands classification from the customer search term only;
- detailed intent and branded/non-branded rollups, retaining Generic Head in raw
  totals while excluding it from addressable opportunity;
- a like-for-like intent comparison guard;
- SQP/PPC joins at profile, marketplace, week, normalized query and ASIN when
  supported, with profile-only, ambiguous and unmatched states;
- one-output-per-PPC-row and spend-conservation assertions;
- review-only, ad-group contextual negative proposal policy;
- parameterized SUPA P1/P2/P3/O1/O2/E1 signals, including stock, organic-rank
  and conversion-gap context.

## Classification rules

Only approved entries affect a final category. Explicit exclusions take
precedence over Own Brand, Competitor and Core. An unapproved matching entry is
`unreviewed`; an unmatched query with no pending suggestion is Generic Head.
This makes human approval explicit without turning an AI suggestion into fact.

Analytics categorization is independent of advertising proposals. Own Brand is
valid in Shield, Competitor is valid in a conquest route, and Core or Head never
becomes a negative merely because of its segment. Every proposed negative is an
ad-group-level export/review record with status `proposed`.

## Doctrine boundary

No production threshold is embedded in this package. SUPA receives every
threshold and target as caller data. Tests use synthetic values solely to prove
branch behavior. The sibling reference implementation was read as specification
and was neither imported nor copied into this repository.

## Verification

The focused suite asserts:

- short-token, punctuation and alias behavior;
- category precedence, marketplace isolation and human approval;
- Sponsored Brands search-term classification;
- raw/detail/brand/opportunity total reconciliation;
- like-for-like intent comparisons;
- exact, profile-only, ambiguous and unmatched joins;
- input/output row parity and spend conservation;
- every contextual negative role/policy branch;
- synthetic coverage of P1, P2, P3, O1, O2 and E1;
- stock, rank and conversion-gap decision overrides;
- caller-controlled thresholds.

## Deferred to later WP-59 lanes

- SP-API request scheduling, report reuse, throttling and row promotion;
- vocabulary persistence, weekly refresh and approval UI;
- PPC attribution mapping persistence and ambiguity resolution;
- Query Intelligence web views and exports;
- live Seller Central/Amazon Audit parity checks.

Those lanes must preserve these pure contracts and continue to count source,
parsed, refused, deduplicated and promoted rows. No code in this package makes
an Amazon API call.
