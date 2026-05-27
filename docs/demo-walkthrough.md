# Demo walkthrough — 5 things to show live, in order

These are the demos that survive scrutiny. Each one takes ≤2 minutes and showcases something a reviewer or new collaborator should care about.

## Pre-demo setup (1 min)

```bash
docker compose up -d
# wait ~10s
curl -s http://localhost:8000/healthz   # {"status":"ok"}
open http://localhost:8501              # Streamlit UI
open http://localhost:8000/docs         # FastAPI Swagger
open http://localhost:6333/dashboard    # Qdrant
```

State to have ready: SEC + Legal already ingested (`make seed-all`).

## Demo 1 — Cite an answer end-to-end on a real question

Streamlit Query page:

> "What does NVIDIA disclose about U.S. export controls affecting semiconductor sales?"

Point out:
- Cited answer (with `[1]`, `[2]` indexes)
- The cited sources panel — file_id + page_start + verbatim excerpt
- The trace card showing the 9 pipeline stages with per-stage latency

This is the "cited or it didn't happen" core feature.

## Demo 2 — Hot-swap domains

Same Streamlit, switch domain dropdown SEC → Legal:

> "What does GPL-3.0 require when distributing modified versions?"

Point out:
- Same UI, same code, totally different schema and corpus
- Eval numbers for Legal are *higher* than for SEC (F1 0.79 vs 0.62) — the system genuinely is domain-agnostic, not just nominally.

## Demo 3 — The structured-query route

Streamlit, SEC domain:

> "Which companies had quarterly revenue exceeding $60 billion?"

Point out:
- Pipeline classified intent as `aggregate`
- DuckDB stage card shows the SQL the LLM generated against the entities table
- The answer cites *individual financial-metric entities*, not narrative paragraphs

(For 2nd-level credibility, mention the `metric_canonical` column + filename-ticker fallback that makes this route actually work — see the "What I'd own" section.)

## Demo 4 — The eval harness

```bash
make eval
# 25-question SEC eval with citation P/R + LLM judge + RAGAS metrics
```

While it runs, narrate:
- Each question has expected files + key facts
- Citation F1 is *deterministic* — exact file-id match
- The LLM judge reads the key_facts and grades the answer
- RAGAS adds 4 more metrics (faithfulness, ctx_precision, ctx_recall, ans_relevance) to triangulate
- Cross-model: I ran this across 5 models. Mid-tier llama-3.1-8b on Groq beats frontier Pro on pass rate. See `LEARNING.md`.

## Demo 5 — What I'd own honestly

This is the strongest impression you can leave: an *honest* engineer.

Open `LEARNING.md` § "Part 4: Decision log" and walk through:
- **D-6**: `duckdb` was missing from `pyproject.toml` — every prior aggregate question 500'd
- **D-7**: Most FinancialMetric entities lacked `ticker` — DuckDB SQL returned NULL
- **D-8**: Metric names are inconsistent across companies — even the ticker-fixed SQL didn't find rows
- **D-9**: Prometheus `record_query` was defined but never called

Each one was *shipped, documented, never exercised end-to-end*. The session's biggest lesson: synthetic e2e evals find bugs no unit test catches, and **loud error logging is leverage**.

## Things to *not* claim in the demo

- Don't claim the DuckDB route fires "perfectly." It fires; the SQL runs; aggregate questions still struggle with metric-name diversity. The fix is shipped; the dataset is too small to show the lift.
- Don't claim "the system answers anything." It answers cited lookup questions extremely well. Aggregates need work. Negative cases (asks about a company not in the corpus) are correctly refused.
- Don't claim "no regressions." The metric_canonical change moved one question ✓→✗ due to LLM nondeterminism — within the ~±4pt noise floor of 25-question evals but worth mentioning.

## If asked "what would you do next?"

In priority order:
1. **Larger eval set** — 25 questions is below the noise floor for detecting <8pt deltas. Need 100+ questions to measure the structured-route fixes properly.
2. **Metric-name canonicalisation at extraction time** — current solution does it at query time as a fallback. Doing it at extraction time would make the entity DB self-consistent.
3. **Retrieval iteration** — citation F1 stuck at ~0.61 across every synth model. The retrieval layer is the bottleneck. Larger candidate pool, stricter rerank, semantic chunking variations.
4. **Per-domain pipeline tuning** — Legal benefits from MMR; SEC doesn't. Should be per-domain config knob.
5. **Real production load testing** — the asyncio worker + SKIP LOCKED queue is elegant but unproven at scale. Need a chaos test.
