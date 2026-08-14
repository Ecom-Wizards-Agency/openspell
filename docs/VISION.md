# wizard-ads — long-term vision (operator, 2026-08-14)

Not a commitment list. These are the directions the operator wants preserved so nearer-term
design decisions don't foreclose them. Items graduate from here into work packages (or into
the in-tool roadmap once WP-15 ships).

## 1. Strategy-per-campaign, not one optimizer for everything

RPC / target-ACOS optimization stays the **default**. On top of it, campaigns (or opt-groups)
can be **assigned a strategy** — chosen manually or suggested from signals:

- **Stock**: low stock → throttle spend and optimize for profitability instead of volume
  (sell the remaining units at better margin, protect rank spend for when stock returns).
  Full automation needs SP-API inventory; the assignment model must not assume infinite stock
  anywhere in the meantime.
- **Usage/run-rate**: pacing-aware strategy shifts (the existing cut-order doctrine).
- **Performance**: push where winnable, protect where defending.

The recommendations engine then optimizes each campaign *for its assigned objective*, and
every proposal says which strategy produced it.

## 2. "Where we can win" — an opportunity engine

SQP share × organic rank × spend joined per keyword (the SUPA + rank lanes) feeding
push/harvest recommendations: keywords where share is buyable, rank is close, or a
competitor is weakening. Opportunity becomes a first-class recommendation reason next to
the four White Box reasons.

## 3. The doctrine brain

The agency's accumulated bidding knowledge (video-corpus distillations, doctrine decisions,
tested playbooks) is loaded as an **operator knowledge pack**: per-tenant database content
consumed by the recommendations engine and the analyst's context resources. It tunes
thresholds, suppressions, and narratives. It is data, never repo code — the repo ships the
mechanism, the operator ships the brain.

## 4. Always-on local analyst

A dedicated always-on machine (operator's Mac mini) runs the headless analyst daily:
read-only MCP key, per-profile context resources, insights written back to the tool, digest
to Slack. The hosted product stays clean; the operator machine variant may additionally
consume private agency context. (WP-13.)

## Graduation path

| Idea | Status today |
|---|---|
| Strategy assignment model | design constraint on WP-07/WP-12 recommendations surface; schema seam exists (`profile_strategy`, opt-group config) |
| Stock-aware throttling | v2 lane, gated on SP-API inventory |
| Opportunity engine | v2 lanes (SUPA, DataDive rank) |
| Doctrine knowledge pack | with WP-12/13; content prepared operator-side |
| Mac mini analyst | WP-13 deployment note |
