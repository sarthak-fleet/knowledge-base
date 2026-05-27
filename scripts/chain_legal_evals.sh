#!/usr/bin/env bash
# Wait for current eval to finish, then run Legal × Flash-lite + Legal × llama-8b
# back-to-back. Each requires an API container restart to pick up AI_MODEL.

set -e
cd "$(dirname "$0")/.."

wait_for_eval_done() {
    while pgrep -f "kb.eval.run" > /dev/null 2>&1; do
        sleep 5
    done
}

wait_for_api() {
    for _ in $(seq 1 30); do
        if curl -s -f http://localhost:8000/healthz > /dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}

run_one() {
    local model="$1"
    local label="$2"
    echo "[chain] === switching AI_MODEL to $model ==="
    sed -i '' "s|^AI_MODEL=.*$|AI_MODEL=$model|" .env
    docker compose up -d --force-recreate api > /dev/null 2>&1
    wait_for_api
    echo "[chain] api healthy, model=$(docker compose exec -T api printenv | grep ^AI_MODEL | tr -d '\r')"
    docker compose exec -T \
        -e KB_JUDGE_MODEL=gemini-2.5-pro \
        api python -m kb.eval.run \
        --domain legal \
        --dataset domains/legal/eval/dataset.yaml \
        --output "/data/eval_results/legal_synth-${label}_judge-pro.json" \
        --ragas 2>&1 | tail -30
}

echo "[chain] waiting for current eval to finish..."
wait_for_eval_done
echo "[chain] previous eval finished, starting flash-lite leg"

run_one gemini-2.5-flash-lite flash-lite

echo "[chain] flash-lite done, starting llama leg"
run_one groq-llama-8b llama-8b

echo "[chain] ALL DONE"
