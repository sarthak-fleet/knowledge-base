"""Tests for the config-driven xlsx_bridge.

The bridge used to be hardcoded to a financial schema (Company + FinancialMetric).
After the refactor, all vocabulary lives in per-domain config; these tests pin
the SEC vocabulary explicitly so they verify the generic function rather than
depending on the YAML loader.
"""

from __future__ import annotations

from kb.extract.xlsx_bridge import XlsxBridgeConfig, extract_xlsx_entities


def _sec_cfg() -> XlsxBridgeConfig:
    return XlsxBridgeConfig.from_pipeline_cfg(
        {
            "xlsx_bridge": {
                "enabled": True,
                "target_entity_type": "FinancialMetric",
                "ident_field": "ticker",
                "ident_columns": ["ticker", "symbol", "company", "issuer"],
                "value_columns": [
                    "revenue",
                    "net income",
                    "eps",
                    "eps diluted",
                ],
                "period_columns": ["period", "quarter", "fiscal year", "year"],
                "name_columns": ["name", "metric"],
            }
        }
    )


def _disabled_cfg() -> XlsxBridgeConfig:
    return XlsxBridgeConfig.from_pipeline_cfg({})


def test_extract_emits_rows_for_sec_shape() -> None:
    rows = [
        ["Ticker", "Quarter", "Revenue", "Net Income"],
        ["AAPL", "Q1 2024", "119575", "33916"],
        ["NVDA", "Q1 2024", "26044", "14881"],
    ]
    records = extract_xlsx_entities(rows, _sec_cfg())
    assert len(records) == 4  # 2 tickers × 2 value columns
    tickers = {r["ticker"] for r in records}
    assert tickers == {"AAPL", "NVDA"}
    assert any(r["name"].lower() == "revenue" and r["value"] == 119575.0 for r in records)
    assert any(r["name"].lower() == "net income" and r["value"] == 14881.0 for r in records)


def test_skips_when_disabled() -> None:
    rows = [
        ["Ticker", "Quarter", "Revenue"],
        ["AAPL", "Q1 2024", "119575"],
    ]
    assert extract_xlsx_entities(rows, _disabled_cfg()) == []


def test_skips_when_no_ident_column() -> None:
    rows = [
        ["Region", "Quarter", "Revenue"],  # no ident-style column
        ["NA", "Q1 2024", "119575"],
    ]
    assert extract_xlsx_entities(rows, _sec_cfg()) == []


def test_skips_when_no_value_column() -> None:
    rows = [
        ["Ticker", "Quarter", "Notes"],  # no value-style column
        ["AAPL", "Q1 2024", "see filing"],
    ]
    assert extract_xlsx_entities(rows, _sec_cfg()) == []


def test_skips_rows_with_non_numeric_value() -> None:
    rows = [
        ["Ticker", "Quarter", "Revenue"],
        ["AAPL", "Q1 2024", "not a number"],
        ["NVDA", "Q1 2024", "26044"],
    ]
    records = extract_xlsx_entities(rows, _sec_cfg())
    assert len(records) == 1
    assert records[0]["ticker"] == "NVDA"


def test_handles_commas_in_numbers() -> None:
    rows = [
        ["Ticker", "Revenue"],
        ["AAPL", "119,575"],
    ]
    records = extract_xlsx_entities(rows, _sec_cfg())
    assert len(records) == 1
    assert records[0]["value"] == 119575.0


def test_provenance_present() -> None:
    rows = [
        ["Ticker", "Quarter", "Revenue"],
        ["AAPL", "Q1 2024", "119575"],
    ]
    records = extract_xlsx_entities(rows, _sec_cfg())
    assert records[0]["_provenance"]["confidence"] == 1.0
    assert "AAPL" in records[0]["_provenance"]["excerpt"]


def test_target_entity_type_independent_of_function() -> None:
    """The function emits row dicts; the runner is what stamps the entity type.

    But is_actionable depends on having target_entity_type set, so a cfg
    without it should produce zero rows even if everything else is configured.
    """
    cfg = XlsxBridgeConfig.from_pipeline_cfg(
        {
            "xlsx_bridge": {
                "enabled": True,
                # target_entity_type intentionally omitted
                "ident_field": "ticker",
                "ident_columns": ["ticker"],
                "value_columns": ["revenue"],
            }
        }
    )
    assert not cfg.is_actionable()
    rows = [["Ticker", "Revenue"], ["AAPL", "100"]]
    assert extract_xlsx_entities(rows, cfg) == []
