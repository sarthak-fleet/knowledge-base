.PHONY: up down logs build seed schema-apply ingest eval test lint fmt clean reset

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

lint:
	uv run ruff check src tests

fmt:
	uv run ruff format src tests
	uv run ruff check --fix src tests

clean:
	docker compose down -v
	rm -rf data/postgres data/qdrant data/minio data/cache

reset: clean up
