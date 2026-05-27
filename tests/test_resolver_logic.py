"""Resolver decision branches — without touching the database."""

from __future__ import annotations

from kb.resolve import resolver as r
from kb.schema.model import DomainSchema, EntityType, FieldSpec


def _schema() -> DomainSchema:
    return DomainSchema(
        domain="t",
        entities=[
            EntityType(
                name="Company",
                summary_field="name",
                fields=[
                    FieldSpec(name="ticker", type="string", identity=True),
                    FieldSpec(name="name", type="string"),
                ],
            ),
            EntityType(name="Filing", fields=[FieldSpec(name="acc", type="string", identity=True)]),
        ],
        relationships=[],
    )


def test_summary_value_uses_summary_field() -> None:
    s = _schema()
    et = s.entity("Company")
    assert r._summary_value(et, {"name": "Apple Inc."}) == "Apple Inc."


def test_summary_value_falls_back() -> None:
    s = _schema()
    et = s.entity("Filing")
    assert r._summary_value(et, {"title": "10-K 2024"}) == "10-K 2024"


def test_topological_order_parents_first() -> None:
    s = DomainSchema(
        domain="t",
        entities=[
            EntityType(name="Section", fields=[FieldSpec(name="h", type="string", identity=True)]),
            EntityType(name="Filing", fields=[FieldSpec(name="a", type="string", identity=True)]),
            EntityType(name="Company", fields=[FieldSpec(name="t", type="string", identity=True)]),
        ],
        relationships=[
            {"name": "f", "kind": "parent", "from_type": "Company", "to_type": "Filing"},
            {"name": "s", "kind": "parent", "from_type": "Filing", "to_type": "Section"},
        ],
    )
    order = r._topological_entity_order(s)
    assert order.index("Company") < order.index("Filing") < order.index("Section")


def test_cosine_handles_empty_and_mismatched() -> None:
    assert r._cosine([], [1.0]) == 0.0
    assert r._cosine([1.0, 0.0], [0.0, 1.0]) == 0.0
    assert r._cosine([1.0, 0.0], [1.0, 0.0]) == 1.0
