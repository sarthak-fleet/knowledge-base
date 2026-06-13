"""Graph route behavior."""

from __future__ import annotations

from kb.query.graph_route import maybe_graph_answer
from kb.query.intent import QueryIntent


async def test_graph_route_returns_none_when_ticker_filters_out_all(monkeypatch) -> None:
    async def fake_get_active_schema(domain: str, project: str = "default"):
        return {
            "spec": {
                "entities": [
                    {"name": "RiskFactor", "fields": [{"name": "ticker"}, {"name": "category"}]}
                ]
            }
        }

    async def fake_list_entities(*, domain: str, type: str, q, limit: int, project: str):
        return [
            {
                "id": "r1",
                "display_name": "Risk",
                "identity_key": "risk-1",
                "fields": {"ticker": "MSFT", "category": "supply"},
            }
        ]

    monkeypatch.setattr("kb.query.graph_route.repo.get_active_schema", fake_get_active_schema)
    monkeypatch.setattr("kb.query.graph_route.repo.list_entities", fake_list_entities)

    out = await maybe_graph_answer(
        intent=QueryIntent(kind="lookup", entity_type="RiskFactor", filters={"ticker": "AAPL"}),
        domain="sec",
        question="themes in NVIDIA filings",
        project="default",
    )

    assert out is None
