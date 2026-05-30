"""XLSX → entities bridge.

The schema-driven LLM extraction often misses per-row XLSX data because the
chunk text doesn't read like natural language. When a domain configures this
bridge, we recognise XLSX content from header shape and emit entities
directly without the LLM.

Heuristic detection:
  - Row 0 is the header.
  - At least one header column maps to the configured `ident_columns` set.
  - At least one header column maps to the configured `value_columns` set.

For each matching row, we emit one entity per (row × value-column), keyed on
the row's identifier and named after the value column. The vocabulary
(`ident_columns`, `value_columns`, etc.) is per-domain config, so this is
not financial-specific — it can serve any domain whose schema has a
row-keyed tabular shape.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import structlog

logger = structlog.get_logger("kb.extract.xlsx_bridge")


@dataclass(frozen=True)
class XlsxBridgeConfig:
    """Per-domain configuration for the xlsx_bridge.

    Built by `XlsxBridgeConfig.from_pipeline_cfg` against the merged config
    dict from `kb.config.pipeline.pipeline_config(domain)`.
    """

    enabled: bool
    target_entity_type: str | None
    ident_field: str | None
    ident_columns: frozenset[str]
    value_columns: frozenset[str]
    period_columns: frozenset[str]
    name_columns: frozenset[str]

    @classmethod
    def from_pipeline_cfg(cls, cfg: dict[str, Any]) -> XlsxBridgeConfig:
        section = cfg.get("xlsx_bridge") or {}

        def _set(key: str) -> frozenset[str]:
            return frozenset(_norm(s) for s in (section.get(key) or []) if s)

        return cls(
            enabled=bool(section.get("enabled")),
            target_entity_type=section.get("target_entity_type") or None,
            ident_field=section.get("ident_field") or None,
            ident_columns=_set("ident_columns"),
            value_columns=_set("value_columns"),
            period_columns=_set("period_columns"),
            name_columns=_set("name_columns"),
        )

    def is_actionable(self) -> bool:
        return bool(
            self.enabled
            and self.target_entity_type
            and self.ident_field
            and self.ident_columns
            and self.value_columns
        )


# Unit-hint patterns. These are heuristics over the value column name; left as
# code rather than config because they only fire when the value column has
# already been recognised, and the buckets are universal (currency vs ratio).
_UNIT_HINTS: list[tuple[str, str]] = [
    ("revenue", "USD-millions"),
    ("income", "USD-millions"),
    ("assets", "USD-millions"),
    ("cash", "USD-millions"),
    ("profit", "USD-millions"),
    ("eps", "USD"),
    ("margin", "%"),
]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def _unit_for(col_name: str) -> str:
    for key, unit in _UNIT_HINTS:
        if key in col_name:
            return unit
    return ""


def _classify_header(headers: list[str], cfg: XlsxBridgeConfig) -> dict[str, int]:
    """Return {role: column_index} keyed by ident / period / name / value:<col>."""
    out: dict[str, int] = {}
    for i, h in enumerate(headers):
        n = _norm(h)
        if not n:
            continue
        if n in cfg.ident_columns:
            out.setdefault("ident", i)
        elif n in cfg.name_columns:
            out.setdefault("name", i)
        elif n in cfg.period_columns or any(p in n for p in cfg.period_columns):
            if "period" not in out:
                out["period"] = i
            else:
                out.setdefault(f"period_extra_{i}", i)
        elif n in cfg.value_columns or any(k in n for k in cfg.value_columns):
            out[f"value:{n}"] = i
    return out


def extract_xlsx_entities(
    rows: list[list[str]],
    cfg: XlsxBridgeConfig,
) -> list[dict[str, Any]]:
    """Given rows of an XLSX (header in row 0), emit entity records per config.

    Returns list of {<ident_field>, name, value, period, unit, _provenance}
    dicts. Empty list if the sheet doesn't match the configured header shape
    or if the bridge isn't actionable for this domain.
    """
    if not cfg.is_actionable() or len(rows) < 2:
        return []
    headers = [str(c) for c in (rows[0] or [])]
    cls = _classify_header(headers, cfg)

    ident_col = cls.get("ident")
    value_cols = [(k.split(":", 1)[1], v) for k, v in cls.items() if k.startswith("value:")]

    if ident_col is None or not value_cols:
        return []

    period_indices = sorted(
        {i for k, i in cls.items() if k == "period" or k.startswith("period_extra_")}
    )

    assert cfg.ident_field is not None  # is_actionable guarantees this
    ident_field = cfg.ident_field

    out: list[dict[str, Any]] = []
    for r_idx, raw in enumerate(rows[1:], start=1):
        row = [str(c) if c is not None else "" for c in raw]
        if not any(c.strip() for c in row):
            continue
        if ident_col >= len(row):
            continue
        ident_val = row[ident_col].strip().upper()
        if not ident_val or len(ident_val) > 8:
            continue
        period_parts = [row[i] for i in period_indices if i < len(row) and row[i].strip()]
        period = " ".join(period_parts).strip() if period_parts else ""
        for col_name, col_idx in value_cols:
            if col_idx >= len(row):
                continue
            raw_val = row[col_idx].strip()
            if not raw_val:
                continue
            try:
                num = float(raw_val.replace(",", ""))
            except (TypeError, ValueError):
                continue
            out.append(
                {
                    ident_field: ident_val,
                    "name": col_name.title(),
                    "value": num,
                    "period": period or "",
                    "unit": _unit_for(col_name),
                    "_provenance": {
                        "page_start": 0,
                        "page_end": 0,
                        "excerpt": f"Row {r_idx}: {ident_val} | {period} | {col_name} = {num}",
                        "confidence": 1.0,
                    },
                }
            )
    if out:
        logger.info(
            "xlsx_bridge: extracted %d %s records",
            len(out),
            cfg.target_entity_type,
        )
    return out
