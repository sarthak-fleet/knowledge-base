"""Source adapters — pluggable inputs that emit bytes + filename + (optional) metadata.

Add a new source by implementing the `Source` Protocol and registering in `registry.py`.

`Source` is intentionally tiny: pull, label, hand off bytes. Everything downstream
(parsing, extraction, ER, indexing) is the same regardless of where the bytes came from.
"""

from kb.sources.base import IngestedDoc, Source
from kb.sources.registry import build_source, register_source, sources

__all__ = ["IngestedDoc", "Source", "build_source", "register_source", "sources"]
