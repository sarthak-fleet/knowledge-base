"""User-defined schema: entity types + fields + relationships, versioned per domain."""

from kb.schema.model import (
    DomainSchema,
    EntityType,
    FieldSpec,
    Relationship,
)

__all__ = ["DomainSchema", "EntityType", "FieldSpec", "Relationship"]
