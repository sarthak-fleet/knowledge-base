"""Pydantic models for user-defined domain schemas.

A schema is just data — the user describes their domain in YAML, and the system
treats every entity type, field, and relationship purely from that description.
No domain-specific code lives in this package.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# Field types are intentionally minimal and JSON-mappable.
FieldType = Literal["string", "text", "integer", "number", "boolean", "date", "datetime", "enum", "array"]


class FieldSpec(BaseModel):
    """A single field on an entity type."""

    name: str
    type: FieldType = "string"
    description: str = ""
    required: bool = False
    identity: bool = False                # part of the entity's identity key (used for ER)
    enum: list[str] | None = None
    item_type: FieldType | None = None    # for arrays
    examples: list[Any] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _valid_ident(cls, v: str) -> str:
        if not v or not v.replace("_", "").isalnum():
            raise ValueError(f"invalid field name: {v!r}")
        return v


class Relationship(BaseModel):
    """An edge between entity types. Hierarchical (`parent`) or cross-ref (`ref`)."""

    name: str
    kind: Literal["parent", "ref"] = "ref"
    from_type: str
    to_type: str
    description: str = ""


class EntityType(BaseModel):
    """One kind of thing in the domain."""

    name: str
    description: str = ""
    fields: list[FieldSpec] = Field(default_factory=list)
    summary_field: str | None = None      # field used for embedding tiebreak in ER
    aliases: list[str] = Field(default_factory=list)

    def identity_fields(self) -> list[FieldSpec]:
        return [f for f in self.fields if f.identity]


class DomainSchema(BaseModel):
    """Top-level schema document."""

    domain: str
    name: str = "default"
    version: int = 1
    description: str = ""
    vocabulary: dict[str, str] = Field(default_factory=dict)  # synonyms / terminology hints
    entities: list[EntityType]
    relationships: list[Relationship] = Field(default_factory=list)

    def entity(self, name: str) -> EntityType:
        for e in self.entities:
            if e.name == name:
                return e
        raise KeyError(f"entity type '{name}' not in schema")

    def children_of(self, parent_type: str) -> list[Relationship]:
        return [r for r in self.relationships if r.kind == "parent" and r.from_type == parent_type]

    def validate_self(self) -> None:
        names = {e.name for e in self.entities}
        for rel in self.relationships:
            if rel.from_type not in names:
                raise ValueError(f"relationship {rel.name}: unknown from_type '{rel.from_type}'")
            if rel.to_type not in names:
                raise ValueError(f"relationship {rel.name}: unknown to_type '{rel.to_type}'")
        for e in self.entities:
            if e.summary_field and not any(f.name == e.summary_field for f in e.fields):
                raise ValueError(f"entity {e.name}: summary_field '{e.summary_field}' not in fields")
            if not e.identity_fields():
                # Warn (don't fail) — ER falls back to display_name + content hash
                pass
