"""LLM client wrapper. OpenAI-compatible; works with DeepSeek, OpenAI, Together, vLLM.

Grok review fixes (2026-05-26):
  - Issue 2: `chat_json` now uses `_coerce_json` on every path so a malformed
    LLM response never raises into callers.
  - Issue 12: every swallowed LLM error is logged at WARNING with type + first
    200 chars. Auth failures (401/402) and quota errors used to be invisible
    `logger.info` calls; now they're loud enough to catch in a tail of the logs.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from openai import AsyncOpenAI
from pydantic import BaseModel
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from kb.config import get_settings

if TYPE_CHECKING:
    import instructor

logger = logging.getLogger("kb.extract.llm")


def make_client() -> AsyncOpenAI:
    s = get_settings()
    return AsyncOpenAI(base_url=s.ai_base_url, api_key=s.ai_api_key or "no-key")


# --------------------------------------------------------------------------
# Deterministic LLM response cache (eval replay).
# Off by default. Enabled via KB_LLM_CACHE_DIR. Files are keyed by sha256 of
# (model, system, user, params) and written atomically.
# --------------------------------------------------------------------------

def _cache_dir() -> Path | None:
    s = get_settings()
    if not s.llm_cache_dir:
        return None
    p = Path(s.llm_cache_dir)
    p.mkdir(parents=True, exist_ok=True)
    return p


def cache_key(*, model: str, system: str, user: str, params: dict[str, Any]) -> str:
    """Stable cache key. Public so eval/* can share the same hash."""
    h = hashlib.sha256()
    sep = b"\x00"
    h.update(model.encode("utf-8"))
    h.update(sep)
    h.update(system.encode("utf-8"))
    h.update(sep)
    h.update(user.encode("utf-8"))
    h.update(sep)
    h.update(json.dumps(params, sort_keys=True, default=str).encode("utf-8"))
    return h.hexdigest()


def cache_get(key: str) -> dict[str, Any] | None:
    d = _cache_dir()
    if not d:
        return None
    f = d / f"{key}.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text())
    except Exception as e:
        logger.warning("llm cache read failed for %s: %s", key[:12], e)
        return None


def cache_put(key: str, value: dict[str, Any]) -> None:
    d = _cache_dir()
    if not d:
        return
    f = d / f"{key}.json"
    tmp = d / f"{key}.json.tmp"
    try:
        tmp.write_text(json.dumps(value))
        os.replace(tmp, f)
    except Exception as e:
        logger.warning("llm cache write failed for %s: %s", key[:12], e)


def _gateway_extras() -> dict[str, Any]:
    """Return per-request extras a routing gateway may require.

    The free-AI gateway demands `project_id` in the request body. We pass it via
    OpenAI SDK's `extra_body=` so the same code path also works with vanilla
    OpenAI/DeepSeek/Together/vLLM (which silently ignore unknown fields).
    """
    s = get_settings()
    if s.ai_project_id:
        return {"extra_body": {"project_id": s.ai_project_id}}
    return {}


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
    """Return (kind, retryable). Kinds: auth | quota | rate | timeout | shape | other.

    Routing gateways (e.g. free-AI gateway) emit `"All providers failed: <X>"`
    wrappers when EVERY upstream provider returns the same shape (incl. 401 /
    402 / timeout). That is a transient *gateway-side* failure, not a terminal
    auth issue on our end — our credentials are unchanged. Classify it as
    rate-limit-shaped (retryable) so tenacity gets a chance to wait it out
    instead of bailing immediately.
    """
    msg = str(e)
    if "All providers failed" in msg:
        return "rate", True
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


# ─── instructor-backed structured outputs ────────────────────────────────
# `chat_structured` is the default for typed LLM outputs: pass a Pydantic
# model and get a validated instance back. Replaces the JSON-schema-dict +
# `_coerce_json` + `.get(...)`-everywhere pattern at most call sites.
#
# `chat_json` (below) is retained on purpose for the two call sites where
# the JSON schema is built dynamically from a domain spec at runtime
# (`extract/runner.py`, `schema/infer.py`) — those benefit from passing a
# fully-described schema with field-level enums to the LLM, which a static
# Pydantic model can't easily express.

_T_MODEL = TypeVar("_T_MODEL", bound="BaseModel")


def _instructor_client() -> instructor.AsyncInstructor:
    """Lazy-build an instructor-wrapped OpenAI client.

    Reuses our existing `make_client()` so the gateway settings + project_id
    `extra_body` plumb continue to work.
    """
    import instructor
    return instructor.from_openai(make_client(), mode=instructor.Mode.TOOLS)


@retry(stop=stop_after_attempt(3), wait=wait_exponential_jitter(initial=1, max=10))
async def chat_structured(
    *,
    system: str,
    user: str,
    response_model: type[_T_MODEL],
    model: str | None = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    timeout_s: float = 120,
) -> _T_MODEL:
    """Ask the LLM for output matching a Pydantic schema.

    Instructor handles: tool-call shape, JSON parsing, validation against the
    Pydantic model, and re-prompting on parse failure. Caller gets a typed
    instance — no `.get(...)` dance, no defensive `isinstance` checks.

    Cache shape mirrors chat_json: keyed by (model, system, user, params) so
    the deterministic-replay layer (`KB_LLM_CACHE_DIR`) keeps working.
    """
    s = get_settings()
    mdl = model or s.extract_model or s.ai_model

    schema_dict = response_model.model_json_schema()
    ck = cache_key(
        model=mdl, system=system, user=user,
        params={"kind": "structured", "schema": schema_dict, "t": temperature, "max": max_tokens},
    )
    hit = cache_get(ck)
    if hit is not None:
        return response_model.model_validate(hit.get("data") or {})

    client = _instructor_client()
    try:
        result: _T_MODEL = await client.chat.completions.create(
            model=mdl,
            response_model=response_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout_s,
            **_gateway_extras(),
        )
    except Exception as e:
        _log_llm_error("chat_structured", e)
        kind, _ = _classify_llm_error(e)
        if kind in ("auth", "quota"):
            raise
        # Defensive default: hand back an empty model so callers don't crash.
        # Pydantic-default-construction works when every field has a default;
        # for required-field models the caller should handle ValidationError.
        try:
            return response_model.model_construct()
        except Exception:
            raise e from None

    cache_put(ck, {"data": result.model_dump()})
    return result


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

    # Cache lookup (eval replay).
    ck = cache_key(
        model=mdl, system=system, user=user,
        params={"kind": "json", "schema": schema, "t": temperature, "max": max_tokens},
    )
    hit = cache_get(ck)
    if hit is not None:
        return hit.get("data", {})

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

    result: dict[str, Any] = {}
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
            **_gateway_extras(),
        )
        choice = resp.choices[0]
        if choice.message.tool_calls:
            args = choice.message.tool_calls[0].function.arguments
            result = _coerce_json(args) if isinstance(args, str) else (args or {})
        else:
            result = _coerce_json(choice.message.content or "")
        cache_put(ck, {"data": result})
        return result
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
                **_gateway_extras(),
            )
            result = _coerce_json(resp.choices[0].message.content or "")
            cache_put(ck, {"data": result})
            return result
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

    ck = cache_key(
        model=mdl, system=system, user=user,
        params={"kind": "text", "t": temperature, "max": max_tokens},
    )
    hit = cache_get(ck)
    if hit is not None:
        # Cached entries record usage so token-accounting stays consistent
        # across replays; if the cached payload predates that field we degrade
        # gracefully.
        return hit.get("text", ""), hit.get("usage") or {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "model": mdl,
        }

    try:
        resp = await client.chat.completions.create(
            model=mdl,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature=temperature,
            max_tokens=max_tokens,
            **_gateway_extras(),
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
    cache_put(ck, {"text": text, "usage": usage})
    return text, usage
