"""Source registry — build a source by name from config."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from kb.sources.base import Source

_SOURCES: dict[str, Callable[..., Source]] = {}


def register_source(name: str) -> Callable[[Callable[..., Source]], Callable[..., Source]]:
    def deco(fn: Callable[..., Source]) -> Callable[..., Source]:
        _SOURCES[name] = fn
        return fn

    return deco


def sources() -> list[str]:
    return sorted(_SOURCES)


def build_source(name: str, **kwargs: Any) -> Source:
    if name not in _SOURCES:
        raise KeyError(f"unknown source '{name}'. available: {sources()}")
    return _SOURCES[name](**kwargs)


# Import side-effect: register built-in sources
from kb.sources import edgar as _edgar  # noqa: E402,F401
from kb.sources import upload as _upload  # noqa: E402,F401
from kb.sources import url as _url  # noqa: E402,F401
