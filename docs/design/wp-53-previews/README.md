# WP-53 dashboard direction previews

Three static 1600 × 1000 previews test different information architectures against the
same synthetic account state. They are decision artifacts only; no production frontend
source was changed.

## Recommendation

Choose **Operator Console** as the default direction. It is the strongest balance of
simple scanning and complete operator access: four primary KPIs, one configurable trend,
a grouped decision queue, spend concentration, and honest data confidence all fit in one
calm viewport. Evidence stays available without turning recommendations into a long list.

| Direction | Best for | Main trade-off |
|---|---|---|
| [Operator Console](operator-console.html) | Daily account operation and the broadest user base | Less simultaneous row-level evidence than the analyst view |
| [Analyst Workspace](analyst-workspace.html) | Power users comparing evidence, filters, and entities | Highest visual density and steeper first-use learning curve |
| [Executive-to-Operator](executive-to-operator.html) | Moving from account outcome to a small number of decisions | Extra narrative layer reduces raw table space |

## Controlled comparison

Every direction contains the same:

- four primary KPIs: Spend, Ad Sales, Orders, and ACOS;
- daily four-metric trend configuration with per-series axis and line/bar treatment;
- Aug 1–27 range, Aug 13 settled boundary, and explicit settling treatment;
- 13 proposed changes grouped into Profit, Rank, and Shield decisions;
- group, decision-type, and urgency views with progressive evidence disclosure;
- current campaign evidence and exact source/coverage status;
- export-only language: review files are produced and nothing is sent to Amazon;
- compact, task-oriented navigation with account/settings controls in the footer.

## Design rules carried forward

- Inter and the existing Ecom Wizards product palette only: Obsidian, Carbon, Slate,
  Signal Orange, Electric Indigo, Cloud, Mist, Hairline, and White.
- Orange is reserved for the primary action, urgency, and a small number of rules.
- Indigo carries data selection and focus. Neutrals carry the interface.
- No gradients, invented semantic hues, decorative shadows, or dashboard card clutter.
- Recommendations are decisions first, entities second. A collapsed group answers
  “what should I decide?”; disclosure answers “why?” and then “which entities?”.

## Preview files

- `operator-console.html` — recommended dense-calm default.
- `analyst-workspace.html` — split-panel, maximum-density alternative.
- `executive-to-operator.html` — summary and insight-led alternative.
- `preview.css` — shared preview-only token and component layer.
- `Inter-Variable.ttf` — verified Ecom Wizards brand-kit font, scoped to the previews.
- `screenshots/` — headless Chrome renders at the target viewport.

All account names, values, and campaign rows in these previews are synthetic.
