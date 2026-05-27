"""Resolve extracted records into canonical entities + persist provenance.

Algorithm per record:
  1. Compute identity_key from schema-declared identity fields.
     → If an entity already exists for (domain, type, identity_key), merge.
  2. Else, gather candidates of the same type whose display_name overlaps lexically.
     - Score with rapidfuzz `token_set_ratio` on the entity's summary field.
     - If the top score is in the "confident" band (>= confident_threshold), merge.
     - If the top score is in the "ambiguous" band (between ambiguous_floor and
       confident_threshold), break the tie with an embedding cosine over the
       summary field. If the embedding score >= embedding_tiebreak_threshold, merge.
  3. Else, create a new canonical entity.
  4. Always: write entity_mention, provenance_span, and parent edges.
"""

from __future__ import annotations

import logging
from typing import Any

from rapidfuzz import fuzz

from kb.config import pipeline
from kb.extract.runner import ExtractedRecord, ExtractionResult
from kb.resolve.keys import identity_key, normalize
from kb.schema.loader import schema_from_dict
from kb.schema.model import DomainSchema, EntityType
from kb.storage import repo
from kb.vector.embed import embed_dense

logger = logging.getLogger("kb.resolve")


def _summary_value(et: EntityType, fields: dict[str, Any]) -> str:
    if et.summary_field and fields.get(et.summary_field):
        return str(fields[et.summary_field])
    for fname in ("name", "title", "heading", "display_name"):
        v = fields.get(fname)
        if v:
            return str(v)
    return ""


def _display_name(et: EntityType, fields: dict[str, Any]) -> str | None:
    val = _summary_value(et, fields)
    return val[:240] if val else None


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def _embedding_tiebreak(target: str, candidates: list[dict[str, Any]]) -> tuple[float, dict | None]:
    """Return (best_score, best_candidate) by cosine over summary text embeddings."""
    if not candidates:
        return 0.0, None
    texts = [target] + [c.get("display_name") or "" for c in candidates]
    try:
        embs = await embed_dense(texts)
    except Exception as e:
        logger.warning("embedding tiebreak failed (%s); falling back to lexical only", e)
        return 0.0, None
    target_vec = embs[0]
    best = (0.0, None)
    for c, v in zip(candidates, embs[1:], strict=True):
        s = _cosine(target_vec, v)
        if s > best[0]:
            best = (s, c)
    return best


async def _resolve_one(
    *,
    schema: DomainSchema,
    domain: str,
    record: ExtractedRecord,
    cfg: dict[str, Any],
    parent_index: dict[str, str],
) -> dict[str, Any] | None:
    et = schema.entity(record.entity_type)
    identity_fields = [f.name for f in et.identity_fields()]
    ik = identity_key(record.fields, identity_fields)
    display = _display_name(et, record.fields)

    canonical: dict[str, Any] | None = None
    if ik:
        canonical = await repo.find_entity(domain=domain, type=et.name, identity_key=ik)

    confident_threshold = float(pipeline.get(cfg, "resolve.confident_threshold", 0.90))
    ambiguous_floor = float(pipeline.get(cfg, "resolve.ambiguous_floor", 0.70))
    emb_threshold = float(pipeline.get(cfg, "resolve.embedding_tiebreak_threshold", 0.86))

    if not canonical and display:
        cands = await repo.list_entities(domain=domain, type=et.name, q=display[:32], limit=25)
        best_lex = (0.0, None)
        for c in cands:
            cn = c.get("display_name") or ""
            score = fuzz.token_set_ratio(normalize(display), normalize(cn)) / 100.0
            if score > best_lex[0]:
                best_lex = (score, c)

        if best_lex[0] >= confident_threshold and best_lex[1]:
            canonical = best_lex[1]
            logger.info("ER lex-confident %.2f %r -> %r", best_lex[0], display, canonical.get("display_name"))
            ik = canonical.get("identity_key") or ik
        elif best_lex[0] >= ambiguous_floor:
            # Ambiguous band → embedding tiebreak
            emb_score, emb_match = await _embedding_tiebreak(display, cands)
            if emb_match and emb_score >= emb_threshold:
                canonical = emb_match
                logger.info(
                    "ER embedding-tiebreak lex=%.2f emb=%.2f %r -> %r",
                    best_lex[0], emb_score, display, canonical.get("display_name"),
                )
                ik = canonical.get("identity_key") or ik

    if not ik:
        ik = f"__noid__:{normalize(display or '')}|{normalize((record.provenance.get('excerpt') or '')[:32])}"

    # Find the schema-declared parent TYPE for this entity (the `from_type` of a
    # `kind: parent` relationship targeting et.name), then look up the most-recent
    # entity of that type processed in this file.
    parent_type: str | None = None
    for rel in schema.relationships:
        if rel.kind == "parent" and rel.to_type == et.name:
            parent_type = rel.from_type
            break
    parent_id = (
        parent_index.get(parent_type) if parent_type else None
    ) or (canonical or {}).get("parent_id")

    entity = await repo.upsert_entity(
        domain=domain,
        type=et.name,
        identity_key=ik,
        display_name=display,
        fields={k: v for k, v in record.fields.items() if v is not None},
        parent_id=parent_id,
    )
    return entity


def _topological_entity_order(schema: DomainSchema) -> list[str]:
    parents: dict[str, set[str]] = {e.name: set() for e in schema.entities}
    for r in schema.relationships:
        if r.kind == "parent":
            parents[r.to_type].add(r.from_type)
    order: list[str] = []
    seen: set[str] = set()
    while len(order) < len(parents):
        progressed = False
        for n, deps in parents.items():
            if n in seen:
                continue
            if deps.issubset(seen):
                order.append(n)
                seen.add(n)
                progressed = True
        if not progressed:
            for e in schema.entities:
                if e.name not in seen:
                    order.append(e.name)
                    seen.add(e.name)
            break
    return order


async def resolve_extraction(result: ExtractionResult) -> dict[str, Any]:
    schema_row = await repo.get_active_schema(result.domain)
    if not schema_row:
        raise RuntimeError(f"no active schema for domain {result.domain}")
    schema = schema_from_dict(schema_row["spec"])
    cfg = pipeline.pipeline_config(result.domain)

    parent_index: dict[str, str] = {}
    counts: dict[str, int] = {}
    cross_refs = [r for r in schema.relationships if r.kind == "ref"]

    order = _topological_entity_order(schema)
    records_by_type: dict[str, list[ExtractedRecord]] = {t: [] for t in order}
    for rec in result.records:
        records_by_type.setdefault(rec.entity_type, []).append(rec)

    for etype in order:
        for rec in records_by_type.get(etype, []):
            entity = await _resolve_one(
                schema=schema,
                domain=result.domain,
                record=rec,
                cfg=cfg,
                parent_index=parent_index,
            )
            if not entity:
                continue
            prov = rec.provenance
            await repo.insert_mention(
                entity_id=entity["id"],
                file_id=result.file_id,
                schema_id=result.schema_id,
                field_values=rec.fields,
                confidence=float(prov.get("confidence", 0.0)),
            )
            await repo.insert_provenance(
                file_id=result.file_id,
                entity_id=entity["id"],
                field=None,
                page_start=int(prov.get("page_start") or rec.window[0]),
                page_end=int(prov.get("page_end") or rec.window[1]),
                element_id=(prov.get("element_ids") or [None])[0],
                excerpt=(prov.get("excerpt") or "")[:1000],
            )
            counts[etype] = counts.get(etype, 0) + 1
            parent_index[etype] = entity["id"]

    for ref in cross_refs:
        src_id = parent_index.get(ref.from_type)
        dst_id = parent_index.get(ref.to_type)
        if src_id and dst_id and src_id != dst_id:
            await repo.insert_relationship(
                domain=result.domain,
                rel_type=ref.name,
                src_id=src_id,
                dst_id=dst_id,
                file_id=result.file_id,
                page=None,
            )

    return {"counts": counts, "parent_index": parent_index}
