# Onboarding a new domain — 30-minute walkthrough

This is the proof that "domain-agnostic" is empirical, not aspirational. We add a brand-new domain (`patents`) from a cold start, with **zero code changes** — only YAML config and document uploads.

The system supports SEC EDGAR filings and SPDX legal licenses today. The walkthrough below shows how a reviewer would add a third sector — say, **patent filings** — by writing one schema, one config, and dropping some PDFs in.

---

## 1. Write the schema (5 min)

Create `domains/patents/schema.yaml`. The schema declares the entity types you want to extract, the fields per entity, identity keys (for dedup), and the relationships:

```yaml
domain: patents
name: "Patents domain"
description: "USPTO and EPO patent filings; extracts inventors, claims, citations."

vocabulary:
  uspto:      "United States Patent and Trademark Office"
  cpc:        "Cooperative Patent Classification"
  prior_art:  "Earlier work cited as relevant to a patent claim"

entities:
  - name: Patent
    description: "A single patent filing."
    summary_field: "title"
    fields:
      - { name: patent_number, type: string,  identity: true,  required: true }
      - { name: title,         type: string,                    required: true }
      - { name: filing_date,   type: date }
      - { name: jurisdiction,  type: enum,   enum: ["US", "EP", "JP", "CN", "WO"] }
      - { name: cpc_class,     type: string }

  - name: Inventor
    description: "Named inventor on a patent."
    summary_field: "name"
    fields:
      - { name: name,    type: string, identity: true, required: true }
      - { name: country, type: string }

  - name: Claim
    description: "One numbered claim from a patent's claim section."
    summary_field: "claim_text"
    fields:
      - { name: number,     type: integer, identity: true, required: true }
      - { name: claim_text, type: text,                     required: true }
      - { name: kind,       type: enum, enum: ["independent", "dependent"] }

relationships:
  - { name: invented_by, kind: ref,    from_type: Patent,  to_type: Inventor }
  - { name: claims_of,   kind: parent, from_type: Claim,   to_type: Patent }
```

The entity definitions become the JSON schema the LLM is asked to fill during extraction — every field's `description` lands in the prompt. No code changes needed to introduce new entity types.

## 2. (Optional) Tune the pipeline (2 min)

Patent filings tend to be dense, formal, and citation-heavy. Override the defaults via `domains/patents/config.yaml`:

```yaml
parse:
  default_strategy: hi_res    # patent PDFs have multi-column layouts
chunk:
  parent_size: 3072            # larger parents for long claim sections
  child_size:  640
retrieve:
  mmr_enabled: true            # patent claims have heavy near-duplicates
  mmr_lambda:  0.5             # bias more aggressively toward diversity
synthesize:
  contextual_retrieval: true   # patent text rewards inter-paragraph context
```

If you don't override, every value inherits from `domains/defaults.yaml`. Anything not in this file uses the platform default.

## 3. Apply the schema (1 command)

```bash
make schema-apply DOMAIN=patents
# or directly:
docker compose exec api python -m kb.cli schema apply domains/patents/schema.yaml
```

The migration registers the schema in Postgres, records the version, and the worker picks it up.

## 4. Upload documents (1 command per file)

```bash
curl -X POST http://localhost:8000/files \
  -F "domain=patents" \
  -F "file=@US10000000.pdf"
```

This enqueues an ingest job. The worker:
1. Parses via Unstructured (PDF strategy from your config)
2. Caches the parse artifact by content hash
3. Extracts entities per your schema using `instructor` + the LLM
4. Resolves entities (deterministic keys + rapidfuzz + embedding tiebreak)
5. Chunks (parent/child + optional Contextual Retrieval)
6. Indexes hybrid (dense + sparse) into a fresh `kb_patents` Qdrant collection

## 5. Ask a question

```bash
curl -X POST http://localhost:8000/query \
  -H 'Content-Type: application/json' \
  -d '{"domain":"patents","question":"Which inventors appear most frequently across the corpus?"}' \
  | jq
```

Returns a cited answer. The intent classifier sees that "most frequently across the corpus" looks aggregate, routes to the DuckDB structured route, generates SQL over the `Inventor` view, and the synthesizer cites the matching patents.

## 6. (Optional) Add an eval set

```yaml
# domains/patents/eval/dataset.yaml
domain: patents
questions:
  - id: p01
    question: "How many independent claims does US10000000 disclose?"
    expected_files: ["US10000000"]
    key_facts:
      - "Independent claim count"
```

Then:

```bash
make eval-patents
```

The same eval runner that scores SEC and Legal scores patents — citation P/R, LLM judge, RAGAS metrics. Cross-domain matrix expands by one column.

---

## What got swapped in for free

Zero code touched. The pieces that **automatically work** for the new domain:

| Component | Why it works without changes |
| --- | --- |
| Parser | Unstructured handles PDFs out of the box; strategy comes from config |
| Extraction | Schema is data, not code — the LLM is asked to fill any schema |
| Entity resolution | Identity keys + fuzzy matching are generic; identity fields come from schema |
| Chunking | Parent/child sizes come from config |
| Hybrid retrieval | New `kb_patents` Qdrant collection created on first upsert |
| Intent + DuckDB route | Intent schema is *derived from* the domain schema (entity types + enum fields become available filters) |
| Synthesis + verify | Prompts reference schema vocabulary, which comes from config |
| Eval harness | Reads a domain/dataset YAML pair; same scoring rubric across all |
| Citation hygiene | Independent of domain |

## What does require code

Three things, and only three:

1. **A new source adapter** if you're not using `upload` or `edgar`. Implement the `Source` Protocol in `src/kb/sources/`. Today: `EdgarSource` and `UploadSource` — together they cover almost every real ingestion path. A USPTO adapter is ~80 lines.

2. **Domain-specific extraction hints** (optional). If your domain has weird tabular data (like SEC's `summary_financials.xlsx`), you can add a per-type extraction *bridge* — see `kb/extract/xlsx_bridge.py` for the pattern. Pure addition; no existing code changes.

3. **Domain-specific evaluators** (optional). Patents might want claim-overlap metrics. Add a new metric to `kb/eval/`; the existing harness picks it up.

---

## How to verify the claim is real

The strongest test is empirical: run `make eval-all` and confirm both SEC and Legal eval sets pass against a deployed system. They use the same pipeline binary, configured differently. Cross-model matrix in `NOTES.md` § 4.7 shows that the same code produces meaningful numbers on both domains — Legal × Flash even *exceeds* SEC × Flash (F1 0.787 vs 0.618).
