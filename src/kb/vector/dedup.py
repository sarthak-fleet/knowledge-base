"""Chunk-level deduplication: normalized content-hash + canonical text hash.

Two surfaces:
  - `content_hash(text)` — sha256 of normalized text. Used to short-circuit
    duplicate chunks at insert time (boilerplate paragraphs, identical
    re-uploads in different formats, etc.).
  - `canonical_hash(elements)` — sha256 of normalized concatenated element
    text. Catches "same document, different format" — PDF vs HTML of the
    same 10-K hash identically here even though their raw bytes differ.

Normalization is deliberately aggressive: lowercase, collapse whitespace,
strip punctuation runs. The goal is to match texts that are *semantically*
identical even if rendered with slightly different formatting.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable

_WS = re.compile(r"\s+")
_PUNCT_RUNS = re.compile(r"[^\w\s]+")


def normalize_text(text: str) -> str:
    """Lowercase, NFKC-normalize, strip punctuation runs, collapse whitespace."""
    if not text:
        return ""
    s = unicodedata.normalize("NFKC", text).lower()
    s = _PUNCT_RUNS.sub(" ", s)
    s = _WS.sub(" ", s).strip()
    return s


def content_hash(text: str) -> str:
    """sha256 of normalized text — stable across formatting differences."""
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def canonical_hash(element_texts: Iterable[str]) -> str:
    """sha256 of normalized concatenation of element texts."""
    joined = " ".join(t for t in element_texts if t)
    return content_hash(joined)
