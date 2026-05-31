# Multi-stage build. The `builder` stage carries the full toolchain
# (build-essential, git, uv) plus all Python deps; the final `runtime` stage
# keeps only the runtime apt packages and copies the installed site-packages
# + the pre-warmed fastembed model cache. Drops ~400 MB off the final image
# (build-essential + gcc + git + apt build deps) without changing functionality.

# ────────────────────────────────────────────────────────────────────────────
# 1. Builder stage: install all Python deps + pre-warm fastembed.
# ────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy

# Toolchain needed at build time only — gcc to compile any wheels that don't
# ship binaries for slim-bookworm, git for any git+ deps (none today, but
# safer to keep at build time), curl + ca-certs for uv index access.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.4.30

WORKDIR /app

# Install deps from pyproject (with a stub src/ so the wheel build succeeds).
# This layer is cacheable as long as pyproject doesn't change.
COPY pyproject.toml README.md ./
RUN mkdir -p src/kb && touch src/kb/__init__.py
RUN uv pip install --system --no-cache .

# Bring in the real source + install editable, no-deps (deps are already there).
COPY . .
RUN uv pip install --system --no-cache --no-deps -e .

# Pre-warm fastembed in the builder so the model cache ends up in the layer
# we copy into runtime. The first /query in a fresh container would otherwise
# pay a ~25 s reranker load + ~2 GB download.
# Pre-warm fastembed model cache. Fastembed's default cache path is
# `/tmp/fastembed_cache`, regardless of the FASTEMBED_CACHE_DIR env var
# (verified empirically — the env var isn't honored in the version pinned
# here). mkdir up-front so the runtime-stage COPY succeeds even when the
# pre-warm fails on a slow/blocked network.
RUN mkdir -p /tmp/fastembed_cache && python -c "\
from fastembed import TextEmbedding, SparseTextEmbedding;\
from fastembed.rerank.cross_encoder import TextCrossEncoder;\
TextEmbedding(model_name='BAAI/bge-large-en-v1.5');\
SparseTextEmbedding(model_name='Qdrant/bm42-all-minilm-l6-v2-attentions');\
TextCrossEncoder(model_name='jinaai/jina-reranker-v2-base-multilingual');\
print('fastembed cache primed')\
" || echo "pre-warm best-effort; runtime will retry"

# ────────────────────────────────────────────────────────────────────────────
# 2. Runtime stage: only the apt packages the running app actually needs.
# ────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Runtime apt deps only (no build-essential, no git):
#   poppler-utils + tesseract — PDF parse path
#   libmagic1, libgl1, libglib2.0-0 — Unstructured / pdf2image runtime
#   libreoffice-* — Unstructured's auto-partition path for .docx/.odt
#   ca-certificates — HTTPS to LLM gateways
#   curl — convenient for in-container debugging / healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
      libmagic1 \
      libreoffice-core \
      libreoffice-writer \
      libreoffice-calc \
      libgl1 \
      libglib2.0-0 \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed Python packages + console scripts from the builder.
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# App source (the editable install's .pth file in site-packages points here).
COPY --from=builder /app /app

# Pre-warmed fastembed cache. fastembed reads from /tmp/fastembed_cache by
# default in the pinned version; the runtime client picks it up automatically
# on first instantiation.
COPY --from=builder /tmp/fastembed_cache /tmp/fastembed_cache

EXPOSE 8000 8501
