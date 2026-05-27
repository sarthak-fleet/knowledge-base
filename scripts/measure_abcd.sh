#!/usr/bin/env bash
# Auto-pipeline for the A+B+C+D measurement:
#   1. Generate a larger SEC eval set (n=60) via scripts/build_eval_set.py
#   2. Run the existing 25-question SEC eval against the new bge-large index
#   3. Run the new 60-question eval against the new bge-large index
#   4. Print both result summaries
# Designed to fire as soon as the reindex finishes.

set -e
cd "$(dirname "$0")/.."

echo
echo "═════════════════════════════════════════════════════════════════"
echo "Step 1 — generate larger eval set (n=60) via LLM"
echo "═════════════════════════════════════════════════════════════════"
docker compose exec -T api python -m scripts.build_eval_set --domain sec --n 60

echo
echo "═════════════════════════════════════════════════════════════════"
echo "Step 2 — run existing 25-Q eval against new bge-large + A/B/C/D"
echo "═════════════════════════════════════════════════════════════════"
docker compose exec -T \
  -e KB_JUDGE_MODEL=gemini-2.5-pro \
  api python -m kb.eval.run \
    --domain sec \
    --dataset domains/sec/eval/dataset.yaml \
    --output /data/eval_results/sec_post-abcd_25q.json \
    --ragas 2>&1 | tail -40

echo
echo "═════════════════════════════════════════════════════════════════"
echo "Step 3 — run new 60-Q eval against new bge-large + A/B/C/D"
echo "═════════════════════════════════════════════════════════════════"
docker compose exec -T \
  -e KB_JUDGE_MODEL=gemini-2.5-pro \
  api python -m kb.eval.run \
    --domain sec \
    --dataset domains/sec/eval/dataset_large.yaml \
    --output /data/eval_results/sec_post-abcd_60q.json \
    --ragas 2>&1 | tail -40

echo
echo "═════════════════════════════════════════════════════════════════"
echo "DONE — compare against pre-ABCD baseline in NOTES.md § 4.7"
echo "═════════════════════════════════════════════════════════════════"
