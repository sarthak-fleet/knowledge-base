.PHONY: up down logs build seed schema-apply ingest eval test lint fmt clean reset demo

up:
	@cp -n .env.example .env || true
	docker compose up -d --build
	@echo
	@echo "API     → http://localhost:8000/docs"
	@echo "Streamlit → http://localhost:8501"
	@echo "MinIO   → http://localhost:9001 (kbminio / kbminio-secret)"
	@echo "Qdrant  → http://localhost:6333/dashboard"

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

build:
	docker compose build

seed: up
	docker compose exec api python -m kb.seed.sec_seed

seed-legal: up
	docker compose exec api python -m kb.seed.legal_seed

seed-all: seed seed-legal

schema-apply: up
	docker compose exec api python -m kb.cli schema apply domains/sec/schema.yaml

ingest: up
	docker compose exec api python -m kb.cli ingest run --domain sec

eval: up
	docker compose exec api python -m kb.eval.run --domain sec --dataset domains/sec/eval/dataset.yaml

eval-legal: up
	docker compose exec api python -m kb.eval.run --domain legal --dataset domains/legal/eval/dataset.yaml --output /app/eval_report_legal.json

test:
	uv run pytest -q

cover:
	uv run pytest --cov=kb --cov-report=term-missing --cov-report=html

typecheck:
	uv run mypy src/kb --ignore-missing-imports --no-strict-optional

lint:
	uv run ruff check src tests
	uv run ruff format --check src tests

fmt:
	uv run ruff format src tests
	uv run ruff check --fix src tests

precommit-install:
	uv tool install pre-commit
	uv tool run pre-commit install

precommit-run:
	uv tool run pre-commit run --all-files

clean:
	docker compose down -v
	rm -rf data/postgres data/qdrant data/minio data/cache

reset: clean up

# Zero-to-cited-answer in one command. Useful for "just show me it works":
#   - bring up the stack
#   - apply both schemas + seed SEC and Legal corpora (idempotent; skips if done)
#   - print three sample cited answers across both domains
demo: seed-all
	@echo
	@echo "── Asking a question on the SEC domain ──────────────────────────────"
	@curl -s -X POST http://localhost:8000/query \
		-H 'Content-Type: application/json' \
		-d '{"domain":"sec","question":"What does NVIDIA disclose about U.S. export controls?"}' \
		| python3 -c "import json,sys; d=json.load(sys.stdin); print('Q: What does NVIDIA disclose about U.S. export controls?\n'); print('Answer:'); print(d.get('answer','')[:400]); print(); print(f'Citations: {len(d.get(\"citations\",[]))} sources')"
	@echo
	@echo "── Same code, different schema — Legal domain ───────────────────────"
	@curl -s -X POST http://localhost:8000/query \
		-H 'Content-Type: application/json' \
		-d '{"domain":"legal","question":"What permission does the MIT License grant?"}' \
		| python3 -c "import json,sys; d=json.load(sys.stdin); print('Q: What permission does the MIT License grant?\n'); print('Answer:'); print(d.get('answer','')[:400]); print(); print(f'Citations: {len(d.get(\"citations\",[]))} sources')"
	@echo
	@echo "── Aggregate question — DuckDB structured route ─────────────────────"
	@curl -s -X POST http://localhost:8000/query \
		-H 'Content-Type: application/json' \
		-d '{"domain":"sec","question":"Which companies had quarterly revenue exceeding $60 billion?"}' \
		| python3 -c "import json,sys; d=json.load(sys.stdin); print('Q: Which companies had quarterly revenue exceeding \$60 billion?\n'); print('Answer:'); print(d.get('answer','')[:400]); print(); print(f'Citations: {len(d.get(\"citations\",[]))} sources')"
	@echo
	@echo "Open http://localhost:8501 for the interactive UI."
