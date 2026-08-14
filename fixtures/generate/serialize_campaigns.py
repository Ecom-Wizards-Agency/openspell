"""Serializers for the campaign-generation goldens.

Same contract as `serialize.py`: every rename from the reference toolkit's
snake_case Python to the TypeScript port's camelCase is written out by hand, so
a rename bug cannot hide by renaming the expectation with it.

Three shapes travel between the two runtimes here:

  * a **config** (`config.TEMPLATE.json` shape) goes in as the case input,
  * a **campaign** (the reference's internal dict) comes out as the plan, and
  * a **bulk row** goes out unchanged, keyed by its Amazon column name.

Bulk rows are deliberately NOT renamed. Their keys are the literal bulksheet
column headers Amazon reads (`"Ad Group Default Bid"`), so a camelCase copy
would be a second vocabulary for the one thing that has to stay verbatim.
"""

from __future__ import annotations

from typing import Any

# --------------------------------------------------------------------------
# config in


def _num(value: Any) -> Any:
    """Refuse anything JSON cannot carry, the way `serialize.num` does."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        f = float(value)
        if f != f or f in (float("inf"), float("-inf")):
            raise ValueError(f"non-finite number in golden output: {value!r}")
    return value


#: Spec keys that carry straight through with a camelCase rename.
_SPEC_KEYS = {
    "campaign_type": "campaignType",
    "campaign_purpose": "campaignPurpose",
    "goal": "goal",
    "product_name": "productName",
    "target_descriptor": "targetDescriptor",
    "sku": "sku",
    "asin": "asin",
    "keywords": "keywords",
    "target_asins": "targetAsins",
    "target_categories": "targetCategories",
    "keywords_per_campaign": "keywordsPerCampaign",
    "transpose_keywords": "transposeKeywords",
    "swap_name_order": "swapNameOrder",
    "skw_include_keyword_in_name": "skwIncludeKeywordInName",
    "match_type": "matchType",
    "daily_budget": "dailyBudget",
    "keyword_bid": "keywordBid",
    "bidding_strategy": "biddingStrategy",
    "portfolio_id": "portfolioId",
    "negative_keywords": "negativeKeywords",
    "negative_target_asins": "negativeTargetAsins",
    "negative_match_type": "negativeMatchType",
    "negative_level": "negativeLevel",
    "state": "state",
    "child_state": "childState",
    "start_date": "startDate",
    "site_restriction": "siteRestriction",
    "top_of_search_placement": "topOfSearchPlacement",
    "rest_of_search_placement": "restOfSearchPlacement",
    "product_pages_placement": "productPagesPlacement",
    "auto_close_match_bid": "autoCloseMatchBid",
    "auto_close_match_state": "autoCloseMatchState",
    "auto_loose_match_bid": "autoLooseMatchBid",
    "auto_loose_match_state": "autoLooseMatchState",
    "auto_substitutes_bid": "autoSubstitutesBid",
    "auto_substitutes_state": "autoSubstitutesState",
    "auto_complements_bid": "autoComplementsBid",
    "auto_complements_state": "autoComplementsState",
}

#: Defaults-block keys. A superset of the spec keys plus the file-wide switches.
_DEFAULTS_KEYS = dict(_SPEC_KEYS)
_DEFAULTS_KEYS["vendor_central_mode"] = "vendorCentralMode"

_NAMING_KEYS = {
    "variable_order": "variableOrder",
    "delimiter": "delimiter",
    "suffix": "suffix",
    "custom1_value": "custom1Value",
    "custom2_value": "custom2Value",
}


def _rename(source: dict, mapping: dict[str, str]) -> dict:
    out: dict[str, Any] = {}
    for key, value in source.items():
        renamed = mapping.get(key)
        if renamed is None:
            raise KeyError(f"no camelCase name registered for config key {key!r}")
        out[renamed] = _num(value)
    return out


def spec(value: dict) -> dict:
    return _rename(value, _SPEC_KEYS)


def naming(value: dict) -> dict:
    return _rename(value, _NAMING_KEYS)


def config(value: dict) -> dict:
    """A loaded builder config as the TypeScript engine's input object."""
    return {
        # `client` and `marketplace` are required by the reference's preflight,
        # which is exactly why a case that omits them has to survive being
        # serialized: the missing-field issue is part of the contract.
        "client": value.get("client", ""),
        "marketplace": value.get("marketplace", ""),
        "naming": naming(value["naming"]),
        "defaults": _rename(value.get("defaults", {}), _DEFAULTS_KEYS),
        "vendorCentralMode": bool(value.get("vendor_central_mode", False)),
        "campaigns": [spec(s) for s in value.get("campaigns", [])],
    }


# --------------------------------------------------------------------------
# campaign out

#: Every key `campaign_model._build_campaign` puts on a campaign dict.
_CAMPAIGN_KEYS = {
    "campaign_name": "campaignName",
    "ad_group_name": "adGroupName",
    "campaign_type": "campaignType",
    "campaign_purpose": "campaignPurpose",
    "goal": "goal",
    "targeting_type": "targetingType",
    "match_type": "matchType",
    "target_descriptor": "targetDescriptor",
    "keywords": "keywords",
    "asins": "asins",
    "categories": "categories",
    "sku": "sku",
    "asin": "asin",
    "daily_budget": "dailyBudget",
    "keyword_bid": "keywordBid",
    "bidding_strategy": "biddingStrategy",
    "negative_keywords": "negativeKeywords",
    "negative_target_asins": "negativeTargetAsins",
    "negative_match_type": "negativeMatchType",
    "negative_level": "negativeLevel",
    "portfolio_id": "portfolioId",
    "state": "state",
    "child_state": "childState",
    "start_date": "startDate",
    "site_restriction": "siteRestriction",
    "top_of_search_placement": "topOfSearchPlacement",
    "rest_of_search_placement": "restOfSearchPlacement",
    "product_pages_placement": "productPagesPlacement",
    "auto_close_match_bid": "autoCloseMatchBid",
    "auto_close_match_state": "autoCloseMatchState",
    "auto_loose_match_bid": "autoLooseMatchBid",
    "auto_loose_match_state": "autoLooseMatchState",
    "auto_substitutes_bid": "autoSubstitutesBid",
    "auto_substitutes_state": "autoSubstitutesState",
    "auto_complements_bid": "autoComplementsBid",
    "auto_complements_state": "autoComplementsState",
}


def campaign(value: dict) -> dict:
    """One generated campaign.

    `trigger_word` and `keyword_text` are intentionally absent: the reference
    puts them on the naming *context*, not on the campaign it appends, so a
    golden carrying them would assert a field the reference does not produce.
    """
    out: dict[str, Any] = {}
    for key, renamed in _CAMPAIGN_KEYS.items():
        if key in value:
            out[renamed] = _num(value[key])
    unknown = set(value) - set(_CAMPAIGN_KEYS)
    if unknown:
        raise KeyError(f"unregistered campaign key(s): {sorted(unknown)}")
    return out


# --------------------------------------------------------------------------
# bulk rows out


def bulk_row(value: dict, columns: list) -> dict:
    """One bulk row, keyed by its literal Amazon column name."""
    return {column: _num(value[column]) for column in columns}


def cell(value: Any) -> Any:
    """One cell as openpyxl reads it back: an empty cell is an empty string.

    Excel has one numeric type, so a float that happens to be integral comes
    back as an int. That is a property of the file format rather than of the
    port, so the golden records what the file actually holds and the TypeScript
    reader normalizes the same way.
    """
    if value is None:
        return ""
    return _num(value)
