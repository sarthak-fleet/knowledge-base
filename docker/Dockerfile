# Slim Python image with system deps Unstructured needs.
FROM python:3.11-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
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
      git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.4.30

WORKDIR /app

# Step 1: install deps from pyproject (with a stub src/ so the wheel build succeeds).
# This layer is cacheable as long as pyproject doesn't change.
COPY pyproject.toml README.md ./
RUN mkdir -p src/kb && touch src/kb/__init__.py
RUN uv pip install --system --no-cache .

# Step 2: bring in the real source + everything else, and install in editable mode
# so future image rebuilds picking up code changes are cheap and predictable.
COPY . .
RUN uv pip install --system --no-cache --no-deps -e .

# Step 3: pre-warm the fastembed model cache so the first request doesn't pay
# download cost (and sparse/reranker don't silently degrade if the network is slow).
ENV FASTEMBED_CACHE_DIR=/opt/fastembed_cache
RUN python -c "\
from fastembed import TextEmbedding, SparseTextEmbedding;\
from fastembed.rerank.cross_encoder import TextCrossEncoder;\
TextEmbedding(model_name='BAAI/bge-small-en-v1.5');\
SparseTextEmbedding(model_name='Qdrant/bm42-all-minilm-l6-v2-attentions');\
TextCrossEncoder(model_name='jinaai/jina-reranker-v2-base-multilingual');\
print('fastembed cache primed')\
" || echo "pre-warm best-effort; runtime will retry"

EXPOSE 8000 8501
