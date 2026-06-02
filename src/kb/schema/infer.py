"""Schema inference: propose a DomainSchema from sample chunks.

The user can drop 5–10 files into a fresh domain without any schema, then call
POST /schemas/infer to get a proposed schema (entity types, fields with NL
descriptions, relationships). Review / edit / apply.

Implementation: pull representative chunks from the corpus, ask the LLM with a
strong system prompt to propose a YAML/JSON schema following our model, validate
the response against DomainSchema, return it for human review.
"""

from __future__ import annotations

import structlog

from kb.extract import llm
from kb.schema.model import DomainSchema

logger = structlog.get_logger("kb.schema.infer")


_SYSTEM = (
    "You are a domain modeller. Given a sample of text chunks from a document corpus, "
    "propose a knowledge-base schema following EXACTLY this JSON shape:\n\n"
    "{\n"
    '  "domain": "<short slug>",\n'
    '  "name": "<schema name>",\n'
    '  "description": "<2-3 sentence summary of this domain>",\n'
    '  "vocabulary": { "<term>": "<definition>", ... },\n'
    '  "entities": [\n'
    "    {\n"
    '      "name": "<EntityName>",\n'
    '      "description": "<one sentence>",\n'
    '      "summary_field": "<field name used for embedding tiebreak>",\n'
    '      "fields": [\n'
    '        { "name": "<field>", "type": "string|text|integer|number|boolean|date|datetime|enum|array",\n'
    '          "description": "<one sentence>", "identity": <bool>, "required": <bool>,\n'
    '          "enum": [...], "item_type": "<for arrays>" }\n'
    "      ]\n"
    "    }\n"
    "  ],\n"
    '  "relationships": [\n'
    '    { "name": "<rel_name>", "kind": "parent|ref",\n'
    '      "from_type": "<EntityName>", "to_type": "<EntityName>",\n'
    '      "description": "<one sentence>" }\n'
    "  ]\n"
    "}\n\n"
    "Rules:\n"
    "  - Identify 3-6 entity types that recurrently appear across the corpus.\n"
    "  - Each entity must have at least one field marked `identity: true`.\n"
    "  - Capture obvious hierarchies via `kind: parent` relationships.\n"
    "  - Capture cross-references via `kind: ref` relationships.\n"
    "  - Fields should be the structured FACTS you can extract — not narrative.\n"
    "  - Use enums when the value space is small and bounded.\n"
    "Return ONLY the JSON object."
)


_SCHEMA_VALIDATION_HINT = {
    "type": "object",
    "properties": {
        "domain": {"type": "string"},
        "name": {"type": "string"},
        "description": {"type": "string"},
        "vocabulary": {"type": "object"},
        "entities": {"type": "array"},
        "relationships": {"type": "array"},
    },
    "required": ["domain", "name", "entities"],
    "additionalProperties": True,
}


def _build_sample_block(samples: list[str], max_each: int = 600, max_total: int = 8000) -> str:
    blocks = []
    total = 0
    for i, s in enumerate(samples, 1):
        chunk = (s or "")[:max_each]
        if total + len(chunk) > max_total:
            break
        blocks.append(f"--- Sample {i} ---\n{chunk}")
        total += len(chunk)
    return "\n\n".join(blocks)


async def infer_schema(
    *,
    domain_hint: str,
    samples: list[str],
    model: str | None = None,
) -> DomainSchema:
    """Propose a schema for `domain_hint` from text samples.

    Raises on LLM failure or invalid schema — caller decides whether to retry
    or surface to the user for manual entry.
    """
    if not samples:
        raise ValueError("schema inference needs at least one sample chunk")

    user = (
        f"Domain hint: {domain_hint}\n\n"
        f"Sample chunks from the corpus:\n\n"
        f"{_build_sample_block(samples)}"
    )
    resp = await llm.chat_json(
        system=_SYSTEM,
        user=user,
        schema=_SCHEMA_VALIDATION_HINT,
        model=model,
        temperature=0.0,
        max_tokens=4096,
        timeout_s=120,
    )
    # Normalise + validate via the pydantic model.
    if not isinstance(resp, dict):
        raise ValueError(f"unexpected response: {resp!r}")
    resp.setdefault("domain", domain_hint)
    resp.setdefault("name", "inferred")
    schema = DomainSchema.model_validate(resp)
    schema.validate_self()
    return schema


async def collect_samples_from_domain(
    domain: str, *, n: int = 12, project: str = "default"
) -> list[str]:
    """Pull representative chunk texts from the chunks table for a given domain."""
    from sqlalchemy import text as _sql

    from kb.storage.db import session

    async with session() as s:
        rows = (
            await s.execute(
                _sql(
                    "SELECT text FROM chunks "
                    "WHERE project = :project AND domain = :d "
                    "ORDER BY random() LIMIT :n"
                ),
                {"project": project, "d": domain, "n": n},
            )
        ).all()
    return [r[0] for r in rows if r[0]]
