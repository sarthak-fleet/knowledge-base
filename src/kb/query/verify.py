"""Citation verification: re-check that each cited claim is actually supported by the source.

Pipeline order: synthesis produces an answer with inline [n] markers. *Before* we
return, we ask the LLM (cheap, structured-output) to decompose the answer into
atomic claims, attribute each claim to one or more citation indices, then for
each (claim, citation) pair: is the cited chunk text sufficient evidence?

Failed pairs get flagged on the trace and downgrade the response confidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import structlog
from pydantic import BaseModel, Field

from kb.extract import llm

logger = structlog.get_logger("kb.query.verify")

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
    "Be conservative: 'supported' only when the excerpt textually contains or directly implies the claim."
)


class _ClaimCheckItem(BaseModel):
    claim: str = ""
    cited: list[int] = Field(default_factory=list)
    supported: bool = False
    reason: str = ""


class _VerifyResponse(BaseModel):
    checks: list[_ClaimCheckItem] = Field(default_factory=list)


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
        resp = await llm.chat_structured(
            system=_VERIFY_SYSTEM,
            user=_build_user_prompt(answer, sources),
            response_model=_VerifyResponse,
            model=model,
            temperature=0.0,
            max_tokens=1024,
            timeout_s=60,
        )
    except Exception as e:
        logger.info("verification skipped (%s)", e)
        return []
    return [
        ClaimCheck(
            claim=c.claim[:300],
            cited_indices=list(c.cited),
            supported=c.supported,
            reason=c.reason[:200],
        )
        for c in resp.checks
    ]


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
