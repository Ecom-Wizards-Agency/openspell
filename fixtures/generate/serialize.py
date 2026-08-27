"""Serializers: reference dataclasses to the JSON the TypeScript ports speak.

Every mapping is written out by hand rather than produced by `asdict`, because
the field renaming (snake_case Python to camelCase TypeScript) is part of the
contract the parity suite checks. A generic converter would hide a rename bug
by renaming the expectation too.

Dates become `YYYY-MM-DD` strings, tuples become lists, and non-finite floats
are refused outright: a golden containing `Infinity` is not JSON, and a golden
containing `NaN` is a bug that would otherwise compare equal to nothing.
"""

from __future__ import annotations

import datetime as dt
from typing import Any, Optional


def num(value: Any) -> Any:
    """Pass a finite number through; refuse anything JSON cannot carry."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        f = float(value)
        if f != f or f in (float("inf"), float("-inf")):
            raise ValueError(f"non-finite number in golden output: {value!r}")
        return value
    return value


def date_str(value: Optional[dt.date]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def daily_row(row: Any) -> Optional[dict]:
    if row is None:
        return None
    return {
        "account": row.account,
        "date": date_str(row.date),
        "level": row.level,
        "impressions": num(row.impressions),
        "clicks": num(row.clicks),
        "spend": num(row.spend),
        "sales": num(row.sales),
        "orders": num(row.orders),
        "campaignId": row.campaign_id,
        "campaignName": row.campaign_name,
        "category": row.category,
        "budget": num(row.budget),
        "budgetCapped": bool(row.budget_capped),
        "totalSales": num(row.total_sales),
        "adSalesSp": num(row.ad_sales_sp),
        "adSalesSd": num(row.ad_sales_sd),
        "realAcos": num(row.real_acos),
        "unitsOrganic": num(row.units_organic),
        "unitsPpc": num(row.units_ppc),
        "refunds": num(row.refunds),
        "grossProfit": num(row.gross_profit),
        "netProfit": num(row.net_profit),
        "margin": num(row.margin),
        "sessions": num(row.sessions),
        "unitSessionPct": num(row.unit_session_pct),
    }


def metric_delta(delta: Any) -> dict:
    return {
        "metric": delta.metric,
        "value": num(delta.value),
        "priorValue": num(delta.prior_value),
        "priorAbsChange": num(delta.prior_abs_change),
        "priorPctChange": num(delta.prior_pct_change),
        "trailing7Avg": num(delta.trailing7_avg),
        "trailing7AbsChange": num(delta.trailing7_abs_change),
        "trailing7PctChange": num(delta.trailing7_pct_change),
        "trend": delta.trend,
    }


def series(analysis: Any) -> dict:
    return {
        "label": analysis.label,
        "campaignId": analysis.campaign_id,
        "category": analysis.category,
        "reportRow": daily_row(analysis.report_row),
        "deltas": {k: metric_delta(v) for k, v in analysis.deltas.items()},
    }


def analysis_result(result: Any) -> dict:
    return {
        "account": result.account,
        "reportDate": date_str(result.report_date),
        "accountSeries": series(result.account_series),
        "campaignSeries": [series(s) for s in result.campaign_series],
    }


def flag(f: Any) -> dict:
    return {
        "severity": f.severity,
        "metric": f.metric,
        "threshold": f.threshold,
        "message": f.message,
        "likelyCause": f.likely_cause,
        "scope": f.scope,
        "category": f.category,
        "suppressed": bool(f.suppressed),
        "suppressedReason": f.suppressed_reason,
    }


def pacing_result(p: Any) -> Optional[dict]:
    if p is None:
        return None
    return {
        "asOf": date_str(p.as_of),
        "monthStart": date_str(p.month_start),
        "dayOfMonth": p.day_of_month,
        "daysInMonth": p.days_in_month,
        "monthlyBudget": num(p.monthly_budget),
        "mtdSpend": num(p.mtd_spend),
        "budgetToDate": num(p.budget_to_date),
        "pace": num(p.pace),
        "status": p.status,
        "daysWithData": p.days_with_data,
        "coverageComplete": bool(p.coverage_complete),
        "guidance": list(p.guidance),
        "notes": list(p.notes),
    }


def weekly_metric_delta(delta: Any) -> dict:
    return {
        "metric": delta.metric,
        "thisWeek": num(delta.this_week),
        "lastWeek": num(delta.last_week),
        "absChange": num(delta.abs_change),
        "pctChange": num(delta.pct_change),
    }


def weekly_analysis(weekly: Any) -> dict:
    return {
        "account": weekly.account,
        "weekEnd": date_str(weekly.week_end),
        "thisWeekStart": date_str(weekly.this_week_start),
        "lastWeekStart": date_str(weekly.last_week_start),
        "lastWeekEnd": date_str(weekly.last_week_end),
        "deltas": {k: weekly_metric_delta(v) for k, v in weekly.deltas.items()},
        "thisWeekRows": [daily_row(r) for r in weekly.this_week_rows],
        "lastWeekRows": [daily_row(r) for r in weekly.last_week_rows],
    }


def push_item(item: Any) -> dict:
    return {
        "entity": item.entity,
        "scope": item.scope,
        "category": item.category,
        "why": item.why,
        "action": item.action,
        "expectedImpact": item.expected_impact,
    }


def pause_item(item: Any) -> dict:
    return {
        "entity": item.entity,
        "scope": item.scope,
        "category": item.category,
        "why": item.why,
        "action": item.action,
    }


def graduate_item(item: Any) -> dict:
    return {
        "keyword": item.keyword,
        "rankNow": item.rank_now,
        "weeksStable": item.weeks_stable,
        "why": item.why,
        "action": item.action,
    }


def test_idea(item: Any) -> dict:
    return {
        "hypothesis": item.hypothesis,
        "method": item.method,
        "successMetric": item.success_metric,
        "source": item.source,
        "status": item.status,
        "priority": item.priority,
    }


def recommendations_result(result: Any) -> dict:
    return {
        "push": [push_item(i) for i in result.push],
        "pauseOptimize": [pause_item(i) for i in result.pause_optimize],
        "tests": [test_idea(i) for i in result.tests],
        "notes": list(result.notes),
        "graduate": [graduate_item(i) for i in result.graduate],
    }


def figure_check(f: Any) -> dict:
    return {
        "figure": f.figure,
        "sellerboardValue": num(f.sellerboard_value),
        "adlabsValue": num(f.adlabs_value),
        "deltaAbs": num(f.delta_abs),
        "deltaPct": num(f.delta_pct),
        "verdict": f.verdict,
    }


def cross_check_result(result: Any) -> dict:
    return {
        "tolerance": num(result.tolerance),
        "figures": [figure_check(f) for f in result.figures],
        "headlineVerdict": result.headline_verdict,
    }


def signal_candidate(item: dict) -> dict:
    """A parsed digest bullet. `requires` is a list of tag-sets; sets are
    unordered in Python, so each is sorted to keep the golden stable."""
    return {
        "hypothesis": item["hypothesis"],
        "successMetric": item.get("success_metric"),
        "source": item.get("source"),
        "confidence": item.get("confidence"),
        "requires": [sorted(tags) for tags in item.get("requires", [])],
    }


def test_candidate(item: dict) -> dict:
    """A select_tests input candidate with deterministic requirement tags."""
    return {
        "id": item.get("id"),
        "hypothesis": item["hypothesis"],
        "method": item.get("method"),
        "success_metric": item.get("success_metric"),
        "source": item.get("source"),
        "priority": item.get("priority"),
        "requires": [sorted(tags) for tags in item.get("requires", [])],
    }
