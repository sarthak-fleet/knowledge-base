"""Citation verification: re-check that each cited claim is actually supported by the source.

Pipeline order: synthesis produces an answer with inline [n] markers. *Before* we
return, we ask the LLM (cheap, structured-output) to decompose the answer into
atomic claims, attribute each claim to one or more citation indices, then for
each (claim, citation) pair: is the cited chunk text sufficient evidence?

Failed pairs get flagged on the trace and downgrade the response confidence.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from kb.extract import llm

logger = logging.getLogger("kb.query.verify")

_CITE_RE = re.compile(r"\[(\d+)\]")


@dataclass
class ClaimCheck:
    claim: str
    cited_indices: list[int]
    supported: bool
    reason: str


_VERIFY_SYSTEM = (
    "You are a strict claims-verification grader. Given an answer paragraph and the "
    "numbered source excerpts it cites, decompose the answer into discrete factual claims, "
    "associate each claim with its supporting [n] citations, and judge whether the cited "
    "excerpts ACTUALLY support that claim. "
    "Be conservative: 'supported' only when the excerpt textually contains or directly implies the claim. "
    'Return JSON: {"checks": [{"claim": "...", "cited": [n, ...], "supported": true|false, "reason": "..."}]}.'
)


_VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string"},
                    "cited": {"type": "array", "items": {"type": "integer"}},
                    "supported": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["claim", "cited", "supported", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["checks"],
    "additionalProperties": False,
}


def _build_user_prompt(answer: str, sources: list[dict[str, Any]]) -> str:
    blocks: list[str] = ["ANSWER:", answer, "", "SOURCES:"]
    for i, h in enumerate(sources, start=1):
        blocks.append(f"[{i}] {h.get('text', '')[:1200]}")
    return "\n".join(blocks)


async def verify_citations(*, answer: str, sources: list[dict[str, Any]], model: str | None = None) -> list[ClaimCheck]:
    """Return per-claim verification results.

    Falls back to a no-op (empty list) on any error — verification is advisory.
    """
    if not answer.strip() or not sources:
        return []
    if not _CITE_RE.search(answer):
        return []  # no claims with citations to verify
    try:
        resp = await llm.chat_json(
            system=_VERIFY_SYSTEM,
            user=_build_user_prompt(answer, sources),
            schema=_VERIFY_SCHEMA,
            model=model,
            temperature=0.0,
            max_tokens=1024,
            timeout_s=60,
        )
    except Exception as e:
        logger.info("verification skipped (%s)", e)
        return []
    out: list[ClaimCheck] = []
    for c in resp.get("checks") or []:
        try:
            out.append(
                ClaimCheck(
                    claim=str(c.get("claim", ""))[:300],
                    cited_indices=[int(i) for i in (c.get("cited") or [])],
                    supported=bool(c.get("supported")),
                    reason=str(c.get("reason", ""))[:200],
                )
            )
        except (TypeError, ValueError):
            continue
    return out


def verification_summary(checks: list[ClaimCheck]) -> dict[str, Any]:
    if not checks:
        return {"checked": 0, "supported": 0, "pass_rate": None}
    supported = sum(1 for c in checks if c.supported)
    return {
        "checked": len(checks),
        "supported": supported,
        "pass_rate": supported / len(checks),
        "failed_claims": [
            {"claim": c.claim, "cited": c.cited_indices, "reason": c.reason}
            for c in checks if not c.supported
        ],
    }


def adjust_confidence_with_verification(
    confidence_value: float,
    confidence_reason: str,
    summary: dict[str, Any],
) -> tuple[float, str]:
    """Downgrade confidence proportionally to unsupported-claim rate."""
    pr = summary.get("pass_rate")
    if pr is None:
        return confidence_value, confidence_reason
    if pr >= 1.0:
        return confidence_value, confidence_reason + " (verified: all claims supported)"
    # Pull confidence toward pass-rate when it's lower.
    adjusted = min(confidence_value, pr)
    reason = f"{confidence_reason} (verification: {summary['supported']}/{summary['checked']} claims supported)"
    return adjusted, reason
