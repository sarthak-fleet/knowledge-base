"""Pipeline config — *not* env. Layered YAML: defaults.yaml < domains/<d>/config.yaml.

Configures behavior the system can change without code edits: model names, thresholds,
chunk sizes, retrieval weights, prompts. Looked up by domain.
"""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

DEFAULTS_PATH = Path(__file__).parent / "defaults.yaml"
DOMAINS_DIR = Path(__file__).resolve().parents[3] / "domains"


def _deep_merge(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(a)
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = deepcopy(v)
    return out


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open() as fh:
        return yaml.safe_load(fh) or {}


@lru_cache(maxsize=64)
def pipeline_config(domain: str | None = None) -> dict[str, Any]:
    cfg = _load_yaml(DEFAULTS_PATH)
    if domain:
        override = _load_yaml(DOMAINS_DIR / domain / "config.yaml")
        cfg = _deep_merge(cfg, override)
    return cfg


def get(cfg: dict[str, Any], dotted: str, default: Any = None) -> Any:
    cur: Any = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur
