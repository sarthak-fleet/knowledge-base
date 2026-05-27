"""Translate a `DomainSchema` (or single `EntityType`) into a JSON Schema the LLM tool-call API accepts.

Each entity becomes a `Record` with the declared fields, plus a `_provenance` block
that the model is told to fill in for every record so we can re-bind extracted
values to source pages / elements.
"""

from __future__ import annotations

from typing import Any

from kb.schema.model import DomainSchema, EntityType, FieldSpec


def _field_to_json_schema(f: FieldSpec) -> dict[str, Any]:
    if f.type == "string" or f.type == "text":
        spec: dict[str, Any] = {"type": "string"}
    elif f.type == "integer":
        spec = {"type": "integer"}
    elif f.type == "number":
        spec = {"type": "number"}
    elif f.type == "boolean":
        spec = {"type": "boolean"}
    elif f.type == "date" or f.type == "datetime":
        spec = {"type": "string", "format": "date" if f.type == "date" else "date-time"}
    elif f.type == "enum":
        spec = {"type": "string", "enum": f.enum or []}
    elif f.type == "array":
        item_type = f.item_type or "string"
        spec = {
            "type": "array",
            "items": _field_to_json_schema(FieldSpec(name="item", type=item_type)),
        }
    else:
        spec = {"type": "string"}
    if f.description:
        spec["description"] = f.description
    return spec


def entity_record_schema(et: EntityType) -> dict[str, Any]:
    props: dict[str, Any] = {}
    required: list[str] = []
    for f in et.fields:
        props[f.name] = _field_to_json_schema(f)
        if f.required:
            required.append(f.name)
    props["_provenance"] = {
        "type": "object",
        "description": "REQUIRED. Source evidence for this record.",
        "properties": {
            "page_start": {
                "type": "integer",
                "description": "First source page supporting this record",
            },
            "page_end": {
                "type": "integer",
                "description": "Last source page supporting this record",
            },
            "excerpt": {
                "type": "string",
                "description": "Verbatim excerpt (<= 400 chars) supporting this record",
            },
            "element_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Source element ids if known",
            },
            "confidence": {"type": "number", "description": "0.0–1.0 self-rated confidence"},
        },
        "required": ["page_start", "page_end", "excerpt", "confidence"],
    }
    return {
        "type": "object",
        "title": et.name,
        "description": et.description,
        "properties": props,
        "required": [*required, "_provenance"],
        "additionalProperties": False,
    }


def extraction_envelope_schema(
    schema: DomainSchema, type_subset: list[str] | None = None
) -> dict[str, Any]:
    """Top-level shape we ask the LLM to return: {entities: {Type: [records...]}}."""
    types = type_subset or [e.name for e in schema.entities]
    return {
        "type": "object",
        "properties": {
            "entities": {
                "type": "object",
                "properties": {
                    t: {"type": "array", "items": entity_record_schema(schema.entity(t))}
                    for t in types
                },
                "required": [],
                "additionalProperties": False,
            }
        },
        "required": ["entities"],
        "additionalProperties": False,
    }
