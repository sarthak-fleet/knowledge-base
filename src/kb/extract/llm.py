"""LLM client wrapper. OpenAI-compatible; works with DeepSeek, OpenAI, Together, vLLM.

Grok review fixes (2026-05-26):
  - Issue 2: `chat_json` now uses `_coerce_json` on every path so a malformed
    LLM response never raises into callers.
  - Issue 12: every swallowed LLM error is logged at WARNING with type + first
    200 chars. Auth failures (401/402) and quota errors used to be invisible
    `logger.info` calls; now they're loud enough to catch in a tail of the logs.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from kb.config import get_settings

logger = logging.getLogger("kb.extract.llm")


def make_client() -> AsyncOpenAI:
    s = get_settings()
    return AsyncOpenAI(base_url=s.ai_base_url, api_key=s.ai_api_key or "no-key")


def _coerce_json(text: str) -> dict[str, Any]:
    """Be liberal in what we accept from an LLM response.

    Strip markdown fences, find the first {...} block, fall back to {}.
    Never raises. Mirrors the same helper used in eval/ragas.py and eval/run.py
    (Grok Issue 2 — make robust parsing the default everywhere).
    """
    if not text:
        return {}
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    try:
        return json.loads(t)
    except Exception:
        pass
    m = re.search(r"\{.*\}", t, flags=re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return {}


def _classify_llm_error(e: BaseException) -> tuple[str, bool]:
    """Return (kind, retryable). Kinds: auth | quota | rate | timeout | shape | other."""
    msg = str(e)
    if "402" in msg or "Insufficient" in msg or "billing" in msg.lower():
        return "quota", False
    if "401" in msg or "Unauthor" in msg or "invalid api key" in msg.lower():
        return "auth", False
    if "429" in msg or "rate limit" in msg.lower():
        return "rate", True
    if "timeout" in msg.lower() or "timed out" in msg.lower():
        return "timeout", True
    if "json" in msg.lower() or "schema" in msg.lower():
        return "shape", True
    return "other", True


def _log_llm_error(where: str, e: BaseException) -> None:
    """Log loudly enough that auth/quota errors are visible in a `docker logs` tail.

    Grok Issue 12: prior code used `logger.info` for swallowed LLM errors, which
    hid the 402 "Insufficient Balance" event during a long eval run. WARNING
    plus error-kind classification makes the root cause immediately obvious.
    """
    kind, _retryable = _classify_llm_error(e)
    cls = type(e).__name__
    msg = str(e)[:200]
    if kind in ("quota", "auth"):
        logger.error("LLM %s FAILED at %s: %s — %s", kind.upper(), where, cls, msg)
    else:
        logger.warning("LLM %s at %s: %s — %s", kind, where, cls, msg)


@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=10))
async def chat_json(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    timeout_s: float = 120,
) -> dict[str, Any]:
    """Ask the LLM for a JSON object matching `schema`. Returns parsed dict.

    Robust to malformed responses (Grok Issue 2). Uses tool-call shape first
    (DeepSeek + OpenAI both support); on tool-call failure falls back to
    `response_format=json_object`; on parse failure returns {} rather than
    raising.
    """
    s = get_settings()
    client = make_client()
    mdl = model or s.extract_model or s.ai_model

    tools = [
        {
            "type": "function",
            "function": {
                "name": "submit",
                "description": "Submit extraction result strictly matching the JSON schema.",
                "parameters": schema,
            },
        }
    ]

    try:
        resp = await client.chat.completions.create(
            model=mdl,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            tools=tools,
            tool_choice={"type": "function", "function": {"name": "submit"}},
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout_s,
        )
        choice = resp.choices[0]
        if choice.message.tool_calls:
            args = choice.message.tool_calls[0].function.arguments
            if isinstance(args, str):
                return _coerce_json(args)
            return args or {}
        return _coerce_json(choice.message.content or "")
    except Exception as e:
        _log_llm_error("chat_json:tool_call", e)
        # If the failure is unambiguous (auth/quota), bail loudly to the caller.
        kind, _retryable = _classify_llm_error(e)
        if kind in ("auth", "quota"):
            raise
        try:
            resp = await client.chat.completions.create(
                model=mdl,
                messages=[
                    {"role": "system", "content": system + "\n\nReturn ONLY a JSON object matching the schema."},
                    {"role": "user", "content": user + "\n\nSchema: " + json.dumps(schema)},
                ],
                response_format={"type": "json_object"},
                temperature=temperature,
                max_tokens=max_tokens,
                timeout=timeout_s,
            )
            return _coerce_json(resp.choices[0].message.content or "")
        except Exception as e2:
            _log_llm_error("chat_json:json_object", e2)
            kind2, _ = _classify_llm_error(e2)
            if kind2 in ("auth", "quota"):
                raise
            return {}


async def chat_text(*, system: str, user: str, model: str | None = None, temperature: float = 0.2, max_tokens: int = 1024) -> str:
    text, _usage = await chat_text_with_usage(
        system=system, user=user, model=model, temperature=temperature, max_tokens=max_tokens,
    )
    return text


async def chat_text_with_usage(
    *,
    system: str,
    user: str,
    model: str | None = None,
    temperature: float = 0.2,
    max_tokens: int = 1024,
) -> tuple[str, dict[str, int]]:
    """Same as chat_text but also returns token usage {prompt, completion, total}.

    Grok Issue 12: errors are now logged at WARNING / ERROR rather than swallowed.
    Auth + quota errors re-raise so the caller can fail loudly instead of producing
    empty strings that silently corrupt the whole pipeline.
    """
    s = get_settings()
    client = make_client()
    mdl = model or s.synthesize_model or s.ai_model
    try:
        resp = await client.chat.completions.create(
            model=mdl,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except Exception as e:
        _log_llm_error("chat_text", e)
        kind, _ = _classify_llm_error(e)
        if kind in ("auth", "quota"):
            raise
        return "", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "model": mdl}
    text = resp.choices[0].message.content or ""
    usage = {
        "prompt_tokens": int(getattr(resp.usage, "prompt_tokens", 0) or 0),
        "completion_tokens": int(getattr(resp.usage, "completion_tokens", 0) or 0),
        "total_tokens": int(getattr(resp.usage, "total_tokens", 0) or 0),
        "model": mdl,
    }
    return text, usage
