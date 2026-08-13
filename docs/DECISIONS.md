# Program decisions log

One line per decision the manager (Fable) or operator makes between work packages.

- **2026-08-13 · Non-converting bid formula default = `projected`** (article-004 model,
  `target × AOV/(clicks + aCTC)`); the older `simple` model (article-001, `AOV/clicks ×
  target`) stays available as `nonConvertingModel: 'simple'`. AdLabs publishes both;
  re-examine at the v1-exit optimizer parity spot-check. (WP-05 ambiguity #6.)
- **2026-08-13 · Change caps are required inputs, never repo defaults** — confirmed WP-05's
  reading; tenant config supplies caps (e.g. 0.25/0.50/0.33). (WP-05 ambiguity #8.)
- **2026-08-13 · TenantStrategy contract widened** to cover the operator's live doctrine
  shape (WP-00.1); widening-only, all new leaves optional. Gap list in the WP-00.1 brief.
- **2026-08-13 · `goal: rank-launch` → pacing condition `launch`** accepted as an
  interpretation (not published by AdLabs); revisit if parity spot-check disagrees.
  (WP-05 ambiguity #7.)
- **2026-08-13 · Recommendation.status vocabulary** frozen as
  `proposed|accepted|dismissed|exported|applied|superseded` (WP-00's judgment call;
  `superseded` replaces the plan's `expired`).
