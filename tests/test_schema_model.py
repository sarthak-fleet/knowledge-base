"""Schema model: identity fields, relationship validation, JSON Schema generation."""

from __future__ import annotations

import yaml

from kb.extract.schema_to_json import entity_record_schema, extraction_envelope_schema
from kb.schema.model import DomainSchema


def _sec_schema() -> DomainSchema:
    from pathlib import Path

    spec = yaml.safe_load((Path(__file__).resolve().parents[1] / "domains/sec/schema.yaml").read_text())
    s = DomainSchema.model_validate(spec)
    s.validate_self()
    return s


def test_identity_fields_present() -> None:
    s = _sec_schema()
    company = s.entity("Company")
    ids = {f.name for f in company.identity_fields()}
    assert "ticker" in ids


def test_relationship_endpoints_resolve() -> None:
    s = _sec_schema()
    for r in s.relationships:
        s.entity(r.from_type)
        s.entity(r.to_type)


def test_record_schema_includes_provenance() -> None:
    s = _sec_schema()
    record = entity_record_schema(s.entity("Filing"))
    assert "_provenance" in record["properties"]
    prov = record["properties"]["_provenance"]
    assert set(prov["required"]) >= {"page_start", "page_end", "excerpt", "confidence"}


def test_envelope_schema_lists_all_types() -> None:
    s = _sec_schema()
    env = extraction_envelope_schema(s)
    expected = {e.name for e in s.entities}
    assert expected == set(env["properties"]["entities"]["properties"].keys())
