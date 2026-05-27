"""Mocked extraction pipeline: schema-driven LLM call returns records with provenance."""

from __future__ import annotations

import asyncio

from kb.extract import runner
from kb.extract.runner import ExtractedRecord
from kb.parse import Element
from kb.schema.loader import schema_from_dict


def _schema_dict() -> dict:
    return {
        "domain": "demo",
        "name": "demo",
        "version": 1,
        "entities": [
            {
                "name": "Company",
                "summary_field": "name",
                "fields": [
                    {"name": "ticker", "type": "string", "identity": True},
                    {"name": "name", "type": "string"},
                ],
            },
            {
                "name": "Filing",
                "fields": [
                    {"name": "accession", "type": "string", "identity": True, "required": True},
                    {"name": "form_type", "type": "string"},
                ],
            },
        ],
        "relationships": [
            {"name": "f", "kind": "parent", "from_type": "Company", "to_type": "Filing"},
        ],
    }


def test_extract_window_returns_records(monkeypatch) -> None:
    schema = schema_from_dict(_schema_dict())
    elements = [
        Element(
            id="el-0",
            type="Title",
            text="Apple Inc. (AAPL) 10-K filing",
            page=1,
            bbox=None,
            parent_id=None,
            metadata={},
        ),
        Element(
            id="el-1",
            type="NarrativeText",
            text="Filed 2024-09-30 under accession 000032019324000123.",
            page=1,
            bbox=None,
            parent_id=None,
            metadata={},
        ),
    ]

    mock_response = {
        "entities": {
            "Company": [
                {
                    "ticker": "AAPL",
                    "name": "Apple Inc.",
                    "_provenance": {
                        "page_start": 1,
                        "page_end": 1,
                        "excerpt": "Apple Inc. (AAPL) 10-K filing",
                        "confidence": 0.9,
                    },
                }
            ],
            "Filing": [
                {
                    "accession": "000032019324000123",
                    "form_type": "10-K",
                    "_provenance": {
                        "page_start": 1,
                        "page_end": 1,
                        "excerpt": "Filed 2024-09-30 under accession 000032019324000123",
                        "confidence": 0.85,
                    },
                }
            ],
        }
    }

    async def fake_chat_json(**kwargs):
        return mock_response

    monkeypatch.setattr(runner.llm, "chat_json", fake_chat_json)

    cfg = {
        "extract": {"confidence_floor": 0.4},
        "llm": {
            "extract": {
                "model": None,
                "temperature": 0,
                "max_tokens": 1024,
                "request_timeout_s": 60,
            }
        },
        "prompts": {"extract_system": "x"},
    }
    out: list[ExtractedRecord] = asyncio.run(
        runner._extract_window(schema, (1, 1), elements, cfg=cfg)
    )
    types = sorted(r.entity_type for r in out)
    assert types == ["Company", "Filing"]
    company = next(r for r in out if r.entity_type == "Company")
    assert company.fields["ticker"] == "AAPL"
    assert company.provenance["page_start"] == 1
    assert "_provenance" not in company.fields


def test_extract_window_drops_low_confidence(monkeypatch) -> None:
    schema = schema_from_dict(_schema_dict())
    elements = [
        Element(
            id="el-0", type="Title", text="noise", page=1, bbox=None, parent_id=None, metadata={}
        )
    ]

    async def fake_chat_json(**kwargs):
        return {
            "entities": {
                "Company": [
                    {
                        "ticker": "X",
                        "name": "X",
                        "_provenance": {
                            "page_start": 1,
                            "page_end": 1,
                            "excerpt": "x",
                            "confidence": 0.1,
                        },
                    },
                ]
            }
        }

    monkeypatch.setattr(runner.llm, "chat_json", fake_chat_json)
    cfg = {
        "extract": {"confidence_floor": 0.4},
        "llm": {"extract": {"request_timeout_s": 60}},
        "prompts": {"extract_system": "x"},
    }
    out = asyncio.run(runner._extract_window(schema, (1, 1), elements, cfg=cfg))
    assert out == []
