"""Top-level service settings (env-driven, no domain values)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="KB_", env_file=".env", extra="ignore")

    # role: api | worker | both — used by CLI / Docker entrypoints
    role: str = "api"

    # --- LLM (OpenAI-compatible) ---
    ai_base_url: str = Field(default="https://api.deepseek.com/v1", alias="AI_BASE_URL")
    ai_api_key: str = Field(default="", alias="AI_API_KEY")
    ai_model: str = Field(default="deepseek-chat", alias="AI_MODEL")
    # Some OpenAI-compatible gateways (e.g. the free routing gateway used in
    # cross-model eval) require an additional `project_id` in the request body
    # for tenancy/billing. Set this only when the upstream demands it; it's
    # ignored by vanilla OpenAI/DeepSeek/Together/vLLM.
    ai_project_id: str = Field(default="", alias="AI_PROJECT_ID")
    extract_model: str | None = None  # KB_EXTRACT_MODEL  (defaults to ai_model)
    synthesize_model: str | None = None  # KB_SYNTHESIZE_MODEL

    # --- LLM response cache (deterministic eval replay) ---
    # Off by default. When set, every (model, system, user, params) tuple is
    # hashed to a JSON file. Subsequent identical calls hit the cache.
    # Intended for eval iteration where the same questions are asked many
    # times against the same docs. Never use in prod paths that need fresh
    # generations.
    llm_cache_dir: str = Field(default="", alias="KB_LLM_CACHE_DIR")

    # --- Embeddings (fastembed, local) ---
    # bge-large-en-v1.5 (1024d) beats bge-small (384d) by ~5-10 pts NDCG on
    # BEIR. The size trade-off (model ~1.3GB vs ~130MB, embeddings ~2.6x
    # bigger in Qdrant) is worth it for any non-toy KB. Override via env.
    embed_model: str = "BAAI/bge-large-en-v1.5"
    embed_dim: int = 1024
    sparse_model: str = "Qdrant/bm42-all-minilm-l6-v2-attentions"

    # --- Storage ---
    postgres_dsn: str = "postgresql+asyncpg://kb:kb@postgres:5432/kb"
    qdrant_url: str = "http://qdrant:6333"
    qdrant_api_key: str = ""
    vector_store: Literal["qdrant", "pgvector"] = "qdrant"
    object_store: Literal["minio", "local"] = "minio"
    minio_endpoint: str = "minio:9000"
    minio_access_key: str = "kbminio"
    minio_secret_key: str = "kbminio-secret"
    minio_bucket: str = "kb"
    minio_secure: bool = False
    local_data_dir: Path = Path("/data")

    # --- API / workers ---
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "info"
    # Default is conservative (2) so the stack runs comfortably on a 16 GB host.
    # `hi_res` PDF parsing alone uses ~2 GB per worker; see .env.example.
    worker_concurrency: int = 2
    parse_strategy_default: Literal["auto", "fast", "hi_res", "ocr_only"] = "auto"
    # When set, parse_pdf runs an extra multimodal pass via the configured AI
    # model to extract tables from page images and add them as supplementary
    # Element rows. Costs an LLM call per page (bounded to 8). Off by default.
    parse_use_vision: bool = Field(default=False, alias="KB_PARSE_USE_VISION")

    @property
    def sync_postgres_dsn(self) -> str:
        return self.postgres_dsn.replace("+asyncpg", "+psycopg")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
