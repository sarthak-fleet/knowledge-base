#!/usr/bin/env bash
# End-to-end verification: assumes `make up` is done and .env has a real AI_API_KEY.
# Uploads a small SEC-shaped doc, runs ingest, queries, dumps the cited answer + trace.
set -euo pipefail

API="${KB_API_URL:-http://localhost:8000}"
DOMAIN="${KB_DOMAIN:-sec}"

echo "─── readyz ───"
curl -sf "$API/readyz" | python3 -m json.tool

echo "─── apply schema ───"
docker compose exec -T api python -m kb.cli schema apply "domains/${DOMAIN}/schema.yaml"

echo "─── upload demo doc ───"
cat > /tmp/kb-demo-doc.txt <<'EOF'
NVIDIA CORPORATION
FORM 10-K
Annual Report for fiscal year ended January 28, 2024

ITEM 1A. RISK FACTORS

Export control regulations: Our products, technology and operations are subject to
U.S. export control laws and regulations, including the Export Administration Regulations.
The U.S. government has imposed restrictions on the export of certain advanced
semiconductor products to specific markets, including China. These restrictions have
materially affected, and may continue to materially affect, our ability to sell certain
products into affected markets.

Customer concentration: Sales to a small number of customers have historically accounted
for a large portion of our revenue. In fiscal 2024, our largest customer accounted for
approximately 13% of total revenue.

Supply chain concentration: A substantial portion of our manufacturing is performed
by Taiwan Semiconductor Manufacturing Company (TSMC). Any disruption to TSMC's
operations would have a material adverse effect on our business.
EOF

FILE_RESP=$(curl -sf -X POST "$API/files" -F "domain=${DOMAIN}" -F "file=@/tmp/kb-demo-doc.txt")
FILE_ID=$(echo "$FILE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "uploaded file_id=$FILE_ID"

echo "─── enqueue ingest ───"
curl -sf -X POST "$API/ingest/run" -H 'Content-Type: application/json' \
  -d "{\"domain\":\"${DOMAIN}\",\"force\":true}" | python3 -m json.tool

echo "─── wait for ready ───"
for i in $(seq 1 30); do
  sleep 4
  status=$(curl -sf "$API/files/${FILE_ID}" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r['status'])")
  echo "  t+$((i*4))s status=$status"
  case "$status" in
    ready) break ;;
    failed)
      curl -sf "$API/files/${FILE_ID}" | python3 -m json.tool
      exit 1
      ;;
  esac
done

echo "─── inspect extracted entities ───"
curl -sf "$API/entities?domain=${DOMAIN}" | python3 -m json.tool | head -40

echo "─── cited query: export controls ───"
curl -sf -X POST "$API/query" -H 'Content-Type: application/json' \
  -d "{\"domain\":\"${DOMAIN}\",\"question\":\"What does NVIDIA disclose about U.S. export controls affecting semiconductor sales?\"}" \
  | python3 -m json.tool

echo "─── cited query: customer concentration ───"
TRACE_ID=$(curl -sf -X POST "$API/query" -H 'Content-Type: application/json' \
  -d "{\"domain\":\"${DOMAIN}\",\"question\":\"What percentage of revenue did NVIDIA's largest customer account for in fiscal 2024?\"}" \
  | tee /tmp/kb-query.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('trace_id',''))")
python3 -m json.tool /tmp/kb-query.json

echo "─── trace inspection ───"
curl -sf "$API/query/trace/${TRACE_ID}" | python3 -m json.tool | head -40

echo
echo "✓ cited-answer path verified end-to-end"
