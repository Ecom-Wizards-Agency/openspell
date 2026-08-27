#!/usr/bin/env python3
"""Generate the UPDATE-mode Python-to-TypeScript parity golden.

The Python reference still reads a downloaded workbook. WP-50 deliberately
replaces that I/O boundary with the synced entity mirror, so this fixture builds
the same synthetic current-state rows in both representations:

* an ``ExportIndex`` for ``update_model.build_change_set_rows``;
* ``EntityRow`` JSON for the TypeScript port.

Only invented ids, names, bids and targets belong here. The reference checkout
is supplied through an environment variable and is never a runtime dependency.

    WIZARD_ADS_CAMPAIGN_REFERENCE_TOOLS=<amazon-campaign-builder-dir> \
      python3 fixtures/generate/generate_campaign_update_goldens.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
GOLDEN = HERE.parent / "golden" / "campaign-update.json"
REFERENCE_ENV = "WIZARD_ADS_CAMPAIGN_REFERENCE_TOOLS"
PROFILE_ID = "50505050-5050-4050-8050-505050505050"


def _load_reference() -> None:
    raw = os.environ.get(REFERENCE_ENV)
    if not raw:
        sys.exit(f"{REFERENCE_ENV} is not set")
    path = Path(raw).expanduser().resolve()
    if not (path / "update_model.py").is_file():
        sys.exit(f"{REFERENCE_ENV}={path} does not contain update_model.py")
    sys.path.insert(0, str(path))


_load_reference()

import campaign_model as cm  # noqa: E402
import update_model as reference  # noqa: E402


def bulk_row(entity: str, **values: Any) -> dict[str, Any]:
    row = {column: "" for column in cm.SP_COLUMNS}
    row.update({"Product": "Sponsored Products", "Entity": entity})
    row.update(values)
    return row


def shared_base(entity_type: str, amazon_id: str, name: str | None, state: str) -> dict[str, Any]:
    return {
        "entityType": entity_type,
        "profileId": PROFILE_ID,
        "amazonId": amazon_id,
        "adProduct": "SP",
        "name": name,
        "state": state,
    }


def build_source() -> tuple[reference.ExportIndex, list[dict[str, Any]]]:
    export = reference.ExportIndex()
    entities: list[dict[str, Any]] = []

    def campaign(cid: str, name: str, *, state: str = "enabled", budget: float = 20.0,
                 portfolio: str = "", end_date: str = "", bidding: str = "Dynamic bids - down only") -> None:
        row = bulk_row(
            "Campaign", **{
                "Campaign ID": cid, "Campaign Name": name, "State": state,
                "Daily Budget": budget, "Portfolio ID": portfolio,
                "End Date": end_date, "Bidding Strategy": bidding,
            }
        )
        export.campaigns[cid] = row
        entities.append({
            **shared_base("campaign", cid, name, state),
            "portfolioId": portfolio or None,
            "budgetAmount": budget,
            "budgetType": "daily",
            "targetingType": "manual",
            "biddingStrategy": {
                "Dynamic bids - down only": "legacy_for_sales",
                "Dynamic bids - up and down": "auto_for_sales",
                "Fixed bid": "manual",
            }[bidding],
            "placementBidding": None,
            "startDate": None,
            "endDate": end_date or None,
        })

    def ad_group(agid: str, cid: str, name: str, *, state: str = "enabled", bid: float = 1.0) -> None:
        row = bulk_row(
            "Ad Group", **{
                "Campaign ID": cid, "Ad Group ID": agid, "Ad Group Name": name,
                "State": state, "Ad Group Default Bid": bid,
            }
        )
        export.ad_groups[agid] = row
        entities.append({
            **shared_base("ad_group", agid, name, state),
            "campaignId": cid,
            "defaultBid": bid,
        })

    def product_ad(adid: str, cid: str, agid: str, *, state: str = "enabled") -> None:
        row = bulk_row(
            "Product Ad", **{
                "Campaign ID": cid, "Ad Group ID": agid, "Ad ID": adid,
                "State": state, "SKU": f"SKU-{adid}", "ASIN": "B000000001",
            }
        )
        export.product_ads[adid] = row
        entities.append({
            **shared_base("product_ad", adid, None, state),
            "campaignId": cid,
            "adGroupId": agid,
            "asin": "B000000001",
            "sku": f"SKU-{adid}",
        })

    def keyword(kid: str, cid: str, agid: str, text: str, match: str,
                *, state: str = "enabled", bid: float = 0.8) -> None:
        row = bulk_row(
            "Keyword", **{
                "Campaign ID": cid, "Ad Group ID": agid, "Keyword ID": kid,
                "Keyword Text": text, "Match Type": match, "State": state, "Bid": bid,
            }
        )
        export.keywords[kid] = row
        entities.append({
            **shared_base("keyword", kid, text, state),
            "campaignId": cid,
            "adGroupId": agid,
            "keywordText": text,
            "matchType": match,
            "bid": bid,
        })

    def negative(nid: str, cid: str, text: str, *, agid: str = "", state: str = "paused",
                 match: str = "negativeExact") -> None:
        entity = "Negative Keyword" if agid else "Campaign Negative Keyword"
        row = bulk_row(
            entity, **{
                "Campaign ID": cid, "Ad Group ID": agid, "Keyword ID": nid,
                "Keyword Text": text, "Match Type": match, "State": state,
            }
        )
        export.negatives[nid] = row
        entities.append({
            **shared_base("negative", nid, text, state),
            "campaignId": cid,
            "adGroupId": agid or None,
            "scope": "ad_group" if agid else "campaign",
            "keywordText": text,
            "expression": None,
            "matchType": "negative_exact" if match == "negativeExact" else "negative_phrase",
        })

    def target(tid: str, cid: str, agid: str, asin: str, *, state: str = "enabled", bid: float = 0.9) -> None:
        expression = f'asin="{asin}"'
        row = bulk_row(
            "Product Targeting", **{
                "Campaign ID": cid, "Ad Group ID": agid, "Product Targeting ID": tid,
                "Product Targeting Expression": expression, "State": state, "Bid": bid,
            }
        )
        export.targets[tid] = row
        entities.append({
            **shared_base("target", tid, expression, state),
            "campaignId": cid,
            "adGroupId": agid,
            "expression": [{"type": "asin_same_as", "value": asin}],
            "resolvedExpression": expression,
            "bid": bid,
        })

    campaign("1001", "Campaign Alpha", portfolio="9001", end_date="20261231")
    campaign("1002", "Campaign Cascade")
    campaign("1003", "Campaign With Archived Group")
    campaign("1004", "Campaign No-op", state="paused", budget=10.0)
    ad_group("2001", "1001", "Alpha ad group")
    ad_group("2002", "1002", "Cascade ad group")
    ad_group("2003", "1003", "Archived ad group")
    ad_group("2004", "1001", "Second live ad group", state="paused", bid=0.75)
    product_ad("3001", "1001", "2001")
    product_ad("3002", "1002", "2002")
    keyword("4001", "1001", "2001", "red widget", "exact")
    keyword("4002", "1001", "2001", "blue widget", "phrase", state="paused", bid=1.25)
    keyword("4003", "1001", "2001", "old widget", "broad")
    keyword("4004", "1001", "2004", "already paused", "exact", state="paused")
    keyword("4005", "1002", "2002", "cascade keyword", "exact")
    keyword("4006", "1003", "2003", "group cascade keyword", "exact")
    negative("5001", "1001", "free widget", agid="2001")
    negative("5002", "1001", "used widget", state="enabled")
    negative("5003", "1002", "cascade negative", agid="2002")
    negative("5004", "1001", "campaign negative", state="paused")
    target("6001", "1001", "2001", "B000000011")
    target("6002", "1001", "2001", "B000000012")
    target("6003", "1002", "2002", "B000000013")

    export.raw_rows = [
        *export.campaigns.values(), *export.ad_groups.values(), *export.product_ads.values(),
        *export.keywords.values(), *export.negatives.values(), *export.targets.values(),
    ]
    return export, entities


def camel_changes(value: dict[str, Any]) -> dict[str, Any]:
    """Explicitly rename the reference config; no generic case converter can hide drift."""
    top = {
        "archive_campaigns": "archiveCampaigns", "archive_ad_groups": "archiveAdGroups",
        "campaigns": "campaigns", "ad_groups": "adGroups", "product_ads": "productAds",
        "keywords": "keywords", "negatives": "negatives", "targets": "targets",
    }
    fields = {
        "campaign_id": "campaignId", "ad_group_id": "adGroupId",
        "name": "name", "daily_budget": "dailyBudget",
        "bidding_strategy": "biddingStrategy", "state": "state", "end_date": "endDate",
        "clear_end_date": "clearEndDate", "placements": "placements",
        "default_bid": "defaultBid", "pause": "pause", "enable": "enable",
        "archive": "archive", "replace": "replace", "add": "add",
        "old_keyword_id": "oldKeywordId", "new_text": "newText",
        "new_match_type": "newMatchType", "new_bid": "newBid", "text": "text",
        "match_type": "matchType", "bid": "bid", "level": "level",
        "asin": "asin", "expanded": "expanded",
    }
    placement = {
        "top_of_search_placement": "topOfSearchPlacement",
        "rest_of_search_placement": "restOfSearchPlacement",
        "product_pages_placement": "productPagesPlacement",
    }

    def rename(item: Any, *, root: bool = False, placement_block: bool = False) -> Any:
        if isinstance(item, list):
            return [rename(entry) for entry in item]
        if not isinstance(item, dict):
            return item
        mapping = top if root else placement if placement_block else fields
        out: dict[str, Any] = {}
        for key, child in item.items():
            renamed = mapping.get(key)
            if renamed is None:
                raise KeyError(f"no TypeScript update key registered for {key!r}")
            out[renamed] = rename(child, placement_block=key == "placements")
        return out

    return rename(value, root=True)


COMPREHENSIVE = {
    "campaigns": [{
        "campaign_id": "1001", "name": "Campaign Alpha Updated", "daily_budget": 25.5,
        "bidding_strategy": "Up and down", "state": "paused", "end_date": "2027-01-31",
        "placements": {"top_of_search_placement": 50, "rest_of_search_placement": 0},
    }],
    "ad_groups": [{"ad_group_id": "2001", "name": "Alpha ad group updated",
                    "default_bid": 1.25, "state": "paused"}],
    "product_ads": {"pause": ["3001"]},
    "keywords": {
        "pause": ["4001", "4004"], "archive": ["4003"],
        "replace": [{"old_keyword_id": "4002", "new_text": "blue widget set",
                     "new_match_type": "BROAD", "state": "enabled"}],
        "add": [{"campaign_id": "1001", "ad_group_id": "2001", "text": "green widget",
                 "match_type": "EXACT", "bid": 0.66}],
    },
    "negatives": {
        "enable": ["5001"], "archive": ["5002"],
        "add": [
            {"campaign_id": "1001", "text": "cheap widget", "match_type": "NEGATIVE_PHRASE"},
            {"campaign_id": "1001", "ad_group_id": "2001", "level": "ad_group",
             "text": "repair widget", "match_type": "NEGATIVE_EXACT"},
        ],
    },
    "targets": {
        "pause": ["6001"], "archive": ["6002"],
        "add": [{"campaign_id": "1001", "ad_group_id": "2001", "asin": "b000000099",
                 "expanded": True, "bid": 0.77, "state": "paused"}],
    },
}

CASCADE = {
    "archive_campaigns": ["1002"],
    "archive_ad_groups": ["2002", "2003"],
    "campaigns": [{"campaign_id": "1002", "daily_budget": 99}],
    "ad_groups": [{"ad_group_id": "2002", "default_bid": 9},
                  {"ad_group_id": "2003", "default_bid": 9}],
    "product_ads": {"pause": ["3002"]},
    "keywords": {"archive": ["4005", "4006"],
                 "add": [{"campaign_id": "1002", "ad_group_id": "2002", "text": "blocked",
                          "match_type": "EXACT"}]},
    "negatives": {"archive": ["5003"]},
    "targets": {"archive": ["6003"]},
}

ERRORS = {
    "archive_campaigns": ["9999"],
    "campaigns": [
        {"campaign_id": "tmp-1", "daily_budget": 1},
        {"campaign_id": "9998", "daily_budget": 1},
        {"campaign_id": "1001", "state": "deleted"},
    ],
    "ad_groups": [{"ad_group_id": "not-real", "default_bid": 1}],
    "product_ads": {"pause": ["3999"]},
    "keywords": {"archive": ["4999"],
                 "add": [{"campaign_id": "1001", "ad_group_id": "2999", "text": "bad"}]},
    "negatives": {"enable": ["5004"]},
    "targets": {"pause": ["6999"]},
}


def cases() -> list[dict[str, Any]]:
    scenarios = [
        ("comprehensive", COMPREHENSIVE, False),
        ("cascade_dedup", CASCADE, False),
        ("blocking_errors", ERRORS, False),
        ("clear_end_date_allowed", {"campaigns": [{"campaign_id": "1001", "clear_end_date": True}]}, True),
        ("clear_end_date_refused", {"campaigns": [{"campaign_id": "1001", "clear_end_date": True}]}, False),
        ("no_op", {"campaigns": [{"campaign_id": "1004", "daily_budget": 10, "state": "paused"}],
                    "ad_groups": [{"ad_group_id": "2004", "default_bid": 0.75, "state": "paused"}]}, False),
    ]
    output = []
    for name, changes, allow_clear in scenarios:
        export, entities = build_source()
        rows, review, errors = reference.build_change_set_rows(
            changes, export, allow_end_date_clear=allow_clear
        )
        output.append({
            "name": name,
            "input": {
                "entities": entities,
                "changes": camel_changes(changes),
                "allowEndDateClear": allow_clear,
            },
            "expected": {
                "rows": [{column: row[column] for column in cm.SP_COLUMNS} for row in rows],
                "review": review,
                "errors": errors,
            },
        })
    return output


def main() -> None:
    document = {
        "schema": "wizard-ads.parity.v1",
        "module": "campaign-update",
        "source": "amazon-agent/tools/amazon-campaign-builder/update_model.py",
        "columns": list(cm.SP_COLUMNS),
        "cases": cases(),
    }
    GOLDEN.write_text(json.dumps(document, indent=2, sort_keys=False) + "\n")
    print(f"wrote {GOLDEN} ({len(document['cases'])} cases)")


if __name__ == "__main__":
    main()
