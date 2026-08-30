# WP-160 — Creative sync visibility

## Problem

Sponsored Brands Video mappings are current-profile-day observations, while the
Creative Performance page defaulted to the last complete day. A valid first
observation could therefore remain invisible. The empty state also could not
distinguish an absent sync, a pending report, a blocked attribution, and a
complete report with zero attributable facts.

## Change

- Include the profile-local current day only on Creative Performance; other
  analytical routes retain their complete-day defaults.
- Read the latest tenant-scoped Creative sync snapshot without loading its
  mapping rows.
- Translate counted snapshot evidence into compact operator lifecycle states.
- Keep mappings and performance explicit: a current asset mapping is never
  presented as performance, and ad-group totals are never substituted.
- Show parsed assets, parsed ads, mapped ads, review counts, evidence date, and
  observed time before the performance table or honest empty state.

## Acceptance evidence

- Pure tests cover timezone day boundaries, current-day presets, and every
  Creative lifecycle state.
- A database integration test proves latest-snapshot selection inside the exact
  organization/profile scope.
- Creative route acceptance exercises every preset through today, while the
  Optimizer retains complete days only.
- Typecheck, lint, tests, hygiene, and visual review remain green.
