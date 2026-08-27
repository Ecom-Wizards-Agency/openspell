#!/usr/bin/env python3
"""Generate the Python-to-TypeScript parity goldens.

Run this against the reference toolkit in the sibling `amazon-agent` project.
It imports the real `analyze`, `flags`, `pacing`, `recommendations`,
`crosscheck` and `datasource` modules, runs every selftest scenario plus the
extra edge cases the ports need pinned, and writes `{input, expected}` goldens
into `fixtures/golden/`.

    WIZARD_ADS_REFERENCE_TOOLS=<path to amazon-agent/tools/amazon-ads-monitor> \
        python3 fixtures/generate/generate_goldens.py

Regenerating is an operator step: the Python environment lives in the other
project, and this repository's CI replays the committed goldens without it. The
reference code is a SPEC, never a dependency: nothing here is imported at
runtime by the TypeScript engine, and nothing is copied into it.

SYNTHETIC DATA ONLY. Every fixture below is hand-built or comes from the
reference's own deterministic mock source. A golden built from a real account
would be a client data leak with extra steps.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN_DIR = HERE.parent / "golden"

REFERENCE_ENV = "WIZARD_ADS_REFERENCE_TOOLS"


def _load_reference() -> None:
    """Put the reference toolkit on the path, from the environment only.

    No absolute path to anybody's home directory is ever written into this
    repository, so the location arrives as an environment variable and a
    missing one is a clear instruction rather than an import traceback.
    """
    raw = os.environ.get(REFERENCE_ENV)
    if not raw:
        sys.exit(
            f"{REFERENCE_ENV} is not set.\n"
            "Point it at the reference toolkit directory (amazon-ads-monitor) in the\n"
            "sibling amazon-agent project, then re-run:\n"
            f"  {REFERENCE_ENV}=<path> python3 fixtures/generate/generate_goldens.py"
        )
    path = Path(raw).expanduser().resolve()
    if not (path / "analyze.py").is_file():
        sys.exit(f"{REFERENCE_ENV}={path} does not look like the reference toolkit (no analyze.py).")
    sys.path.insert(0, str(path))


_load_reference()
sys.path.insert(0, str(HERE))

import serialize as S  # noqa: E402
from analyze import aggregate_week, analyze_account, classify_trend  # noqa: E402
from crosscheck import cross_check, render_verdict_emoji_line, render_verdict_line  # noqa: E402
from datasource import (  # noqa: E402
    CATEGORY_DISCOVERY,
    CATEGORY_RANK,
    DailyRow,
    MockDataSource,
    SELLERBOARD_METRICS,
    classify_campaign_category,
)
from flags import evaluate, resolve_goal_lens  # noqa: E402
from pacing import compute_pacing, pacing_flag  # noqa: E402
from recommendations import (  # noqa: E402
    build_recommendations,
    parse_signal_digest_markdown,
    select_tests,
)

SCHEMA = "wizard-ads.parity.v1"

GOALS = [
    None,
    "rank-launch",
    "scale",
    "profit-maintain",
    "defend",
    "maintain",
    "liquidate",
    "inactive",
    "not-a-real-goal",
]

# ---------------------------------------------------------------------------
# Fixture 1: the five hand-built campaigns from the reference selftest, each
# engineered to trip exactly one rule, plus a deliberate cross-campaign
# discovery-bloat trigger.

REPORT_DATE = dt.date(2026, 7, 12)

SPECS = {
    "A": {  # Rank/SKW: wide ACOS swing -> must be SUPPRESSED, not active.
        "name": "Rank | SP | Exact | widget | SYN-WID | EW",
        "category": CATEGORY_RANK,
        "baseline": dict(impressions=1000, clicks=40, spend=50.0, sales=100.0, orders=4),
        "day0": dict(sales=25.0),
    },
    "B": {  # Discovery: CVR collapse with stable clicks -> real anomaly, warn.
        "name": "Discovery Auto | SP | Auto | widget | SYN | EW",
        "category": CATEGORY_DISCOVERY,
        "baseline": dict(impressions=2000, clicks=100, spend=49.0, sales=224.0, orders=8),
        "day0": dict(clicks=98, orders=1, sales=28.0),
    },
    "C": {  # Rank/SKW: near-zero impressions -> real anomaly, alert.
        "name": "Rank | SP | Exact | gadget | SYN-GAD | EW",
        "category": CATEGORY_RANK,
        "baseline": dict(impressions=800, clicks=32, spend=40.0, sales=80.0, orders=3),
        "day0": dict(impressions=5, clicks=1, spend=2.0, sales=0.0, orders=0),
    },
    "D": {  # Discovery: real spend, persistently zero orders -> alert.
        "name": "Discovery Phrase | SP | Phrase | thing | SYN | EW",
        "category": CATEGORY_DISCOVERY,
        "baseline": dict(impressions=1500, clicks=15, spend=30.0, sales=0.0, orders=0),
        "day0": {},
    },
    "E": {  # Rank/SKW: budget-capped on the report day -> real anomaly, warn.
        "name": "Rank | SP | Exact | thingy | SYN-THY | EW",
        "category": CATEGORY_RANK,
        "baseline": dict(
            impressions=900, clicks=36, spend=35.0, sales=70.0, orders=3, budget=40.0, budget_capped=False
        ),
        "day0": dict(spend=39.5, budget_capped=True),
    },
}


def build_campaign_fixture():
    campaign_rows = []
    per_day_totals = {}
    for cid, spec in SPECS.items():
        for offset in range(0, 8):
            date = REPORT_DATE - dt.timedelta(days=offset)
            values = dict(spec["baseline"])
            if offset == 0:
                values.update(spec["day0"])
            row = DailyRow(
                account="synthetic-acct",
                date=date,
                level="campaign",
                impressions=values.get("impressions", 0),
                clicks=values.get("clicks", 0),
                spend=values.get("spend", 0.0),
                sales=values.get("sales", 0.0),
                orders=values.get("orders", 0),
                campaign_id=cid,
                campaign_name=spec["name"],
                category=spec["category"],
                budget=values.get("budget"),
                budget_capped=values.get("budget_capped", False),
            )
            campaign_rows.append(row)
            totals = per_day_totals.setdefault(
                date, {"impressions": 0, "clicks": 0, "spend": 0.0, "sales": 0.0, "orders": 0}
            )
            totals["impressions"] += row.impressions
            totals["clicks"] += row.clicks
            totals["spend"] += row.spend
            totals["sales"] += row.sales
            totals["orders"] += row.orders

    account_rows = [
        DailyRow(account="synthetic-acct", date=d, level="account", **t) for d, t in per_day_totals.items()
    ]
    return account_rows, campaign_rows


# ---------------------------------------------------------------------------
# Fixture 2: an account-totals series with a sharp TACOS rise and margin drop on
# the report day against a flat trailing week. Two goal lenses must read the
# identical numbers oppositely.

LENS_REPORT_DATE = dt.date(2026, 7, 13)


def build_lens_fixture():
    rows = []
    for offset in range(0, 8):
        d = LENS_REPORT_DATE - dt.timedelta(days=offset)
        if offset == 0:
            spend, total_sales, margin = 60.0, 300.0, 0.05  # TACOS 20%, margin 5%
        else:
            spend, total_sales, margin = 30.0, 300.0, 0.20  # TACOS 10%, margin 20%
        rows.append(
            DailyRow(
                account="lens-test",
                date=d,
                level="account",
                impressions=0,
                clicks=0,
                spend=spend,
                sales=spend,
                orders=5,
                total_sales=total_sales,
                margin=margin,
                real_acos=0.1,
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Fixture 3: a two-week account-totals series with distinct this-week and
# last-week values on every summed metric.

WEEK_END = dt.date(2026, 7, 12)


def build_weekly_fixture(account: str = "weekly-test"):
    rows = []
    this_week_start = WEEK_END - dt.timedelta(days=6)
    last_week_start = this_week_start - dt.timedelta(days=7)
    for offset in range(14):
        d = last_week_start + dt.timedelta(days=offset)
        if d >= this_week_start:
            total_sales, spend, sales, orders, net_profit = 1200.0, 150.0, 400.0, 12, 250.0
        else:
            total_sales, spend, sales, orders, net_profit = 1000.0, 100.0, 300.0, 10, 200.0
        rows.append(
            DailyRow(
                account=account,
                date=d,
                level="account",
                impressions=0,
                clicks=0,
                spend=spend,
                sales=sales,
                orders=orders,
                total_sales=total_sales,
                net_profit=net_profit,
                real_acos=0.15,
            )
        )
    return rows


# ---------------------------------------------------------------------------
# Fixture 4: the reference's own deterministic mock source. Its scenarios are
# scripted (impression collapse, spend spike, budget cap), so replaying its rows
# exercises every rule on data this generator did not hand-tune.


def build_mock_fixture(account: str, report_date: dt.date, days: int = 14):
    ds = MockDataSource()
    start = report_date - dt.timedelta(days=days)
    return ds.get_account_daily(account, start, report_date), ds.get_campaign_daily(account, start, report_date)


# ---------------------------------------------------------------------------
# Recommendation entities: synthetic AdLabs-style weekly rows.

PROFIT_ENTITY = {
    "entity_type": "target",
    "name": "mid acos halo target",
    "campaign_name": "Halo | SP | Exact | widget long tail | SYN | EW",
    "campaign_id": "c-halo",
    "match_type": "exact",
    "impressions": 2000,
    "clicks": 100,
    "spend": 90.0,
    "sales": 300.0,
    "orders": 5,
}
RANK_ENTITY = {
    "entity_type": "target",
    "name": "high acos rank keyword",
    "campaign_name": "Rank | SP | Exact | widget | SYN-WID | EW",
    "campaign_id": "c-rank",
    "match_type": "exact",
    "impressions": 3000,
    "clicks": 150,
    "spend": 150.0,
    "sales": 100.0,
    "orders": 5,
}
HEALTHY_RANK_ENTITY = {
    "entity_type": "target",
    "name": "healthy rank keyword",
    "campaign_name": "Rank | SP | Exact | gizmo | SYN-GIZ | EW",
    "campaign_id": "c-rank-2",
    "match_type": "exact",
    "impressions": 5000,
    "clicks": 200,
    "spend": 40.0,
    "sales": 200.0,
    "orders": 8,
}
ZERO_SALE_DISCOVERY = {
    "entity_type": "target",
    "name": "bleeding discovery term",
    "campaign_name": "Discovery Auto | SP | Auto | widget | SYN | EW",
    "campaign_id": "c-disco",
    "match_type": "broad",
    "impressions": 4000,
    "clicks": 60,
    "spend": 45.0,
    "sales": 0.0,
    "orders": 0,
}
COLLAPSED_RANK = {
    "entity_type": "target",
    "name": "collapsed rank keyword",
    "campaign_name": "Rank | SP | Exact | doohickey | SYN-DOO | EW",
    "campaign_id": "c-rank-3",
    "match_type": "exact",
    "impressions": 40,
    "clicks": 2,
    "spend": 1.5,
    "sales": 0.0,
    "orders": 0,
    "daily_budget": 20.0,
    "budget_capped_days": 3,
}
SHIELD_ENTITY = {
    "entity_type": "target",
    "name": "brand shield term",
    "campaign_name": "Shield | SP | Exact | brand | SYN | EW",
    "campaign_id": "c-shield",
    "match_type": "exact",
    "impressions": 50,
    "clicks": 5,
    "spend": 3.0,
    "sales": 40.0,
    "orders": 2,
    "budget_capped_days": 2,
}
SELF_COMPETITION_A = {
    "entity_type": "target",
    "name": "duplicated term",
    "campaign_name": "Halo | SP | Exact | dup | SYN | EW",
    "campaign_id": "c-dup-a",
    "match_type": "exact",
    "impressions": 900,
    "clicks": 30,
    "spend": 12.0,
    "sales": 100.0,
    "orders": 3,
}
SELF_COMPETITION_B = {
    "entity_type": "target",
    "name": "duplicated term",
    "campaign_name": "Discovery Phrase | SP | Phrase | dup | SYN | EW",
    "campaign_id": "c-dup-b",
    "match_type": "exact",
    "impressions": 400,
    "clicks": 10,
    "spend": 8.0,
    "sales": 20.0,
    "orders": 1,
}
STALLED_CAMPAIGN_ROW = {
    "entity_type": "campaign",
    "name": "Halo | SP | Exact | stalled | SYN | EW",
    "campaign_name": "Halo | SP | Exact | stalled | SYN | EW",
    "campaign_id": "c-stalled",
    "impressions": 3,
    "clicks": 0,
    "spend": 0.0,
    "sales": 0.0,
    "orders": 0,
}

RADAR_ROWS = [
    {"keyword": RANK_ENTITY["name"], "rank_now": 1, "rank_prev": 1, "weeks_stable": 4},
    {"keyword": PROFIT_ENTITY["name"], "rank_now": 8, "rank_prev": 15, "weeks_stable": 0},
    {"keyword": "almost there keyword", "rank_now": 2, "rank_prev": 4, "weeks_stable": 1},
    {"keyword": "", "rank_now": 3, "rank_prev": 4, "weeks_stable": 5},
    {"keyword": "no rank at all", "rank_now": None, "rank_prev": 2, "weeks_stable": 5},
]

DIGEST_TEXT = (
    "- **Test broad-match variants alongside the exact Rank keyword.** "
    "Tags: rank_present. Source: PPC Newsletter #42. Confidence: unverified.\n"
    "- a bullet that does not follow the convention at all\n"
    "- **Untagged claim.** Tags: . Source: Somewhere. Confidence: low.\n"
)


# ---------------------------------------------------------------------------
# Case builders. Each returns (cases, module_name).


def classify_cases():
    names = [
        "Rank | SP | Exact | widget | SYN-WID | EW",
        "Discovery Auto | SP | Auto | widget | SYN | EW",
        "Halo | SP | Exact | long tail | SYN | EW",
        "Shield | SP | Exact | brand | SYN | EW",
        "Shield Discovery BMM | SP | Broad | brand | SYN | EW",
        "SKW gizmo",
        "profit stack",
        "phrase harvest",
        "broad sweep",
        "bmm test",
        "something else entirely",
        "",
    ]
    return [
        {"name": f"classify[{i}]", "input": {"campaignName": n}, "expected": classify_campaign_category(n)}
        for i, n in enumerate(names)
    ]


def trend_cases():
    series = [
        [1, 1, 1, 2, 2, 2],
        [2, 2, 2, 1, 1, 1],
        [10, 10.2, 9.9, 10.1, 10, 9.95],
        [None, None, 5],
        [],
        [5],
        [0, 0, 0, 0],
        [0, 0, 1, 1],
        [None, 3, None, 4],
        [-4, -4, -2, -2],
    ]
    return [
        {"name": f"classify_trend[{i}]", "input": {"values": s}, "expected": classify_trend(list(s))}
        for i, s in enumerate(series)
    ]


def _fixture_payload(account, report_date, acct_rows, camp_rows, metrics):
    return {
        "account": account,
        "reportDate": report_date.isoformat(),
        "accountRows": [S.daily_row(r) for r in acct_rows],
        "campaignRows": [S.daily_row(r) for r in camp_rows],
        "metrics": metrics,
    }


def _series_fixtures():
    """The shared analysis fixtures, built once.

    Cases reference a fixture by name instead of embedding its rows, because 54
    flag cases over the same three row sets would otherwise be megabytes of
    duplicated JSON and a reviewer could not tell the copies apart.
    """
    account_rows, campaign_rows = build_campaign_fixture()
    lens_rows = build_lens_fixture()
    mock_account_rows, mock_campaign_rows = build_mock_fixture("acme-us", dt.date(2026, 3, 15))
    sparse_rows = [r for r in account_rows if r.date != REPORT_DATE - dt.timedelta(days=3)]
    return {
        "campaign_fixture": ("synthetic-acct", REPORT_DATE, account_rows, campaign_rows, None),
        "account_totals": ("lens-test", LENS_REPORT_DATE, lens_rows, [], list(SELLERBOARD_METRICS)),
        "mock_source": ("acme-us", dt.date(2026, 3, 15), mock_account_rows, mock_campaign_rows, None),
        "sparse_account_series": ("synthetic-acct", REPORT_DATE, sparse_rows, [], None),
        "empty_series": ("synthetic-acct", REPORT_DATE, [], [], None),
    }


def analyze_cases():
    fixtures = _series_fixtures()
    cases = []
    for name, (account, report_date, acct_rows, camp_rows, metrics) in fixtures.items():
        result = analyze_account(
            account,
            report_date,
            acct_rows,
            camp_rows,
            metrics=tuple(metrics) if metrics else None,
        )
        cases.append(
            {
                "name": f"analyze_account:{name}",
                "input": {"fixture": name},
                "expected": S.analysis_result(result),
            }
        )
    payload_fixtures = {
        name: _fixture_payload(*spec) for name, spec in fixtures.items()
    }
    return cases, payload_fixtures


def weekly_cases():
    rows = build_weekly_fixture()
    holed = [r for r in rows if r.date != WEEK_END - dt.timedelta(days=2)]
    cases = []
    for name, week_rows in (("full", rows), ("missing_day", holed), ("empty", [])):
        weekly = aggregate_week(week_rows, WEEK_END)
        cases.append(
            {
                "name": f"aggregate_week:{name}",
                "input": {
                    "weekEnd": WEEK_END.isoformat(),
                    "accountRows": [S.daily_row(r) for r in week_rows],
                },
                "expected": S.weekly_analysis(weekly),
            }
        )
    return cases


def flags_cases():
    fixtures = _series_fixtures()
    used = ["campaign_fixture", "account_totals", "mock_source"]
    configs = [
        ("default", None),
        ("tight_config", {"thresholds": {"spend_spike_pct": 0.05, "zero_sales_spend_min": 1.0}}),
    ]

    cases = []
    for fixture_name in used:
        account, report_date, acct_rows, camp_rows, metrics = fixtures[fixture_name]
        analysis = analyze_account(
            account, report_date, acct_rows, camp_rows, metrics=tuple(metrics) if metrics else None
        )
        for config_name, config in configs:
            for goal in GOALS:
                active, suppressed = evaluate(analysis, config=config, goal=goal)
                cases.append(
                    {
                        "name": f"evaluate:{fixture_name}:{config_name}:{goal or 'none'}",
                        "input": {"fixture": fixture_name, "config": config, "goal": goal},
                        "expected": {
                            "active": [S.flag(f) for f in active],
                            "suppressed": [S.flag(f) for f in suppressed],
                        },
                    }
                )
    payload_fixtures = {name: _fixture_payload(*fixtures[name]) for name in used}
    return cases, payload_fixtures


class _SpendDay:
    """The minimal row `compute_pacing` reads: a date and a spend figure."""

    def __init__(self, date, spend):
        self.date = date
        self.spend = spend


def _spend_days(start: dt.date, days: int, spend_per_day: float):
    return [_SpendDay(start + dt.timedelta(days=i), spend_per_day) for i in range(days)]


def pacing_cases():
    as_of = dt.date(2026, 7, 10)  # day 10 of a 31-day month
    july1 = dt.date(2026, 7, 1)
    feb_as_of = dt.date(2028, 2, 29)  # leap day, to pin the days-in-month arithmetic

    scenarios = [
        ("no_budget", _spend_days(july1, 10, 130.0), as_of, None, None, None),
        ("act", _spend_days(july1, 10, 130.0), as_of, 3100.0, None, None),
        ("warn_neutral", _spend_days(july1, 10, 115.0), as_of, 3100.0, None, None),
        ("act_under_profit_maintain", _spend_days(july1, 10, 120.0), as_of, 3100.0, "profit-maintain", None),
        ("rank_launch_tolerates", _spend_days(july1, 10, 130.0), as_of, 3100.0, "rank-launch", None),
        ("underpace", _spend_days(july1, 10, 50.0), as_of, 3100.0, None, None),
        ("partial_coverage", _spend_days(dt.date(2026, 7, 6), 5, 100.0), as_of, 3100.0, None, None),
        ("on_pace", _spend_days(july1, 10, 100.0), as_of, 3100.0, None, None),
        (
            "config_overrides_lens",
            _spend_days(july1, 10, 130.0),
            as_of,
            3100.0,
            "rank-launch",
            {"pacing": {"act_above": 1.05}},
        ),
        ("leap_month", _spend_days(dt.date(2028, 2, 1), 29, 100.0), feb_as_of, 3000.0, None, None),
        ("rows_outside_month_ignored", _spend_days(dt.date(2026, 6, 25), 20, 100.0), as_of, 3100.0, None, None),
    ]

    cases = []
    for name, rows, when, budget, goal, config in scenarios:
        lens = resolve_goal_lens(goal) if goal else None
        result = compute_pacing(rows, when, budget, lens=lens, config=config)
        flag = pacing_flag(result, lens=lens)
        cases.append(
            {
                "name": f"compute_pacing:{name}",
                "input": {
                    "rows": [{"date": r.date.isoformat(), "spend": r.spend} for r in rows],
                    "asOf": when.isoformat(),
                    "monthlyBudget": budget,
                    "goal": goal,
                    "config": config,
                },
                "expected": {
                    "pacing": S.pacing_result(result),
                    "flag": S.flag(flag) if flag is not None else None,
                },
            }
        )
    return cases


def crosscheck_cases():
    sb = {"ad_spend": 100.0, "ad_sales": 500.0, "total_sales": 2000.0}
    scenarios = [
        ("verified", sb, {"ad_spend": 104.0, "ad_sales": 480.0, "total_sales": 2050.0}, None),
        ("mismatch_ad_spend", sb, {"ad_spend": 160.0, "ad_sales": 480.0, "total_sales": 2050.0}, None),
        ("no_data", {}, {}, None),
        ("custom_tolerance", sb, {"ad_spend": 106.0}, 0.10),
        ("partial_sides", sb, {"ad_sales": 500.0}, None),
        ("zero_base_nonzero_other", {"ad_spend": 0.0}, {"ad_spend": 12.0}, None),
        ("zero_base_zero_other", {"ad_spend": 0.0}, {"ad_spend": 0.0}, None),
        ("exactly_at_tolerance", {"ad_spend": 100.0}, {"ad_spend": 107.0}, None),
        ("negative_direction", sb, {"ad_spend": 40.0, "ad_sales": 500.0, "total_sales": 2000.0}, None),
    ]
    cases = []
    for name, sellerboard, adlabs, tolerance in scenarios:
        result = cross_check(sellerboard, adlabs) if tolerance is None else cross_check(sellerboard, adlabs, tolerance)
        cases.append(
            {
                "name": f"cross_check:{name}",
                "input": {"sellerboard": sellerboard, "adlabs": adlabs, "tolerance": tolerance},
                "expected": {
                    "result": S.cross_check_result(result),
                    "line": render_verdict_line(result),
                    "emojiLine": render_verdict_emoji_line(result),
                },
            }
        )
    return cases


def recommendation_cases():
    base = [dict(PROFIT_ENTITY), dict(RANK_ENTITY)]
    wide = [
        dict(PROFIT_ENTITY),
        dict(RANK_ENTITY),
        dict(ZERO_SALE_DISCOVERY),
        dict(COLLAPSED_RANK),
        dict(SHIELD_ENTITY),
        dict(SELF_COMPETITION_A),
        dict(SELF_COMPETITION_B),
        dict(STALLED_CAMPAIGN_ROW),
    ]
    signal_items = parse_signal_digest_markdown(DIGEST_TEXT)

    over_pacing = compute_pacing(_spend_days(dt.date(2026, 7, 1), 10, 130.0), dt.date(2026, 7, 10), 3100.0)

    scenarios = [
        ("goal_profit_maintain", base, {"goal": "profit-maintain"}),
        ("goal_rank_launch", base, {"goal": "rank-launch"}),
        ("goal_liquidate", base, {"goal": "liquidate"}),
        ("goal_none", base, {}),
        ("wide_neutral", wide, {}),
        ("wide_profit_maintain", wide, {"goal": "profit-maintain"}),
        ("wide_scale_with_situation", wide, {"goal": "scale", "situation": "competitor hijack on brand terms"}),
        ("radar_protection", base, {"goal": "profit-maintain", "rank_radar": RADAR_ROWS}),
        ("radar_with_wide_set", wide, {"goal": "defend", "rank_radar": RADAR_ROWS}),
        ("healthy_rank_only", [dict(HEALTHY_RANK_ENTITY)], {}),
        ("signal_driven", [dict(HEALTHY_RANK_ENTITY)], {"signal_items": signal_items}),
        ("empty_entities", [], {}),
        (
            "config_override",
            wide,
            {"goal": "scale", "config": {"rec_thresholds": {"zero_sale_spend_min_weekly": 5.0, "graduate_rank_max": 1}}},
        ),
        ("pacing_act_note", base, {"goal": "profit-maintain", "pacing": over_pacing}),
    ]

    cases = []
    for name, entities, kwargs in scenarios:
        result = build_recommendations(entities, **kwargs)
        case_input = {
            "rawEntities": entities,
            "goal": kwargs.get("goal"),
            "situation": kwargs.get("situation"),
            "rankRadar": kwargs.get("rank_radar"),
            "config": kwargs.get("config"),
            "signalItems": [S.signal_candidate(s) for s in kwargs.get("signal_items", [])] or None,
            "pacing": S.pacing_result(kwargs.get("pacing")) if kwargs.get("pacing") else None,
        }
        cases.append(
            {
                "name": f"build_recommendations:{name}",
                "input": case_input,
                "expected": S.recommendations_result(result),
            }
        )

    cases.append(
        {
            "name": "parse_signal_digest_markdown:mixed",
            "input": {"text": DIGEST_TEXT},
            "expected": [S.signal_candidate(s) for s in signal_items],
        }
    )
    cases.append(
        {
            "name": "parse_signal_digest_markdown:empty",
            "input": {"text": ""},
            "expected": [],
        }
    )
    return cases


def test_backlog_cases():
    custom_candidates = [
        {
            "id": "custom-match",
            "hypothesis": "A tagged candidate is selected.",
            "method": "Run the tagged candidate.",
            "success_metric": "The tagged metric improves.",
            "source": "synthetic#custom-match",
            "priority": "high",
            "requires": [{"custom", "goal:scale"}],
        },
        {
            "id": "custom-untagged",
            "hypothesis": "An untagged candidate is never filler.",
            "method": "This must not run.",
            "success_metric": "This must not surface.",
            "source": "synthetic#custom-untagged",
            "requires": [],
        },
    ]
    signal_items = [
        {
            "hypothesis": "A relevant external signal deserves a controlled test.",
            "source": "synthetic digest",
            "priority": "low",
            "requires": [{"external_match"}],
        }
    ]
    scenarios = [
        ("empty_tags", set(), None, None),
        ("rank_launch", {"rank_present", "goal:rank-launch"}, None, None),
        (
            "scale_with_categories",
            {"rank_present", "discovery_present", "profit_present", "goal:scale"},
            None,
            None,
        ),
        ("defend_with_shield", {"goal:defend", "shield_present"}, None, None),
        ("account_signals", {"high_acos_non_rank", "discovery_bloat"}, None, None),
        ("unrelated_tags", {"crisis_mentioned", "stalled_campaign"}, None, None),
        ("explicit_empty_candidates", {"rank_present", "goal:rank-launch"}, [], None),
        ("custom_and_gating", {"custom", "goal:scale"}, custom_candidates, None),
        ("external_signal", {"external_match"}, [], signal_items),
    ]
    cases = []
    for name, tags, candidates, signals in scenarios:
        selected = select_tests(tags, candidates=candidates, signal_items=signals)
        cases.append(
            {
                "name": f"select_tests:{name}",
                "input": {
                    "brandTags": sorted(tags),
                    "candidates": None if candidates is None else [S.test_candidate(c) for c in candidates],
                    "signalItems": None if signals is None else [S.test_candidate(s) for s in signals],
                },
                "expected": [S.test_idea(item) for item in selected],
            }
        )
    return cases


def write(module: str, cases: list, fixtures: dict | None = None) -> None:
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    path = GOLDEN_DIR / f"{module}.json"
    payload = {
        "schema": SCHEMA,
        "module": module,
        "source": "amazon-agent/tools/amazon-ads-monitor (read-only reference)",
        "synthetic": True,
        "fixtures": fixtures or {},
        "cases": cases,
    }
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False, allow_nan=False, sort_keys=False)
        fh.write("\n")
    print(f"{path.relative_to(GOLDEN_DIR.parent.parent)}: {len(cases)} cases")


def main() -> int:
    write("classify", classify_cases())
    write("trend", trend_cases())
    write("analyze", *analyze_cases())
    write("weekly", weekly_cases())
    write("flags", *flags_cases())
    write("pacing", pacing_cases())
    write("crosscheck", crosscheck_cases())
    write("recommendations", recommendation_cases())
    write("test-backlog", test_backlog_cases())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
