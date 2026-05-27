"""Identity-key normalization.

Schema fields marked `identity: true` form the entity's key. We concatenate
their normalized string forms with `␟` (UNIT SEPARATOR) so distinct field
values never collide.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

_SPACES = re.compile(r"\s+")
_PUNCT = re.compile(r"[^a-z0-9\s\-_/]")


def normalize(v: Any) -> str:
    if v is None:
        return ""
    s = str(v).strip().lower()
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode("ascii")
    s = _PUNCT.sub(" ", s)
    s = _SPACES.sub(" ", s).strip()
    return s


def identity_key(values: dict[str, Any], identity_field_names: list[str]) -> str:
    if not identity_field_names:
        # Fall back to a synthetic key based on whatever fields we have.
        sig = "|".join(f"{k}={normalize(v)}" for k, v in sorted(values.items()) if v is not None)
        return f"__synth__:{sig}"
    parts = [normalize(values.get(f, "")) for f in identity_field_names]
    if not any(parts):
        return ""
    return "␟".join(parts)
