"""LLM client wrapper. OpenAI-compatible; works with DeepSeek, OpenAI, Together, vLLM."""

from __future__ import annotations

import json
import logging
from typing import Any

from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential_jitter

from kb.config import get_settings

logger = logging.getLogger("kb.extract.llm")


def make_client() -> AsyncOpenAI:
    s = get_settings()
    return AsyncOpenAI(base_url=s.ai_base_url, api_key=s.ai_api_key or "no-key")


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

    Uses prompt-level JSON instructions + `response_format={"type": "json_object"}`
    for compatibility across providers (DeepSeek, OpenAI, vLLM). For full structured-
    output via JSON Schema we use a `tools` shape that DeepSeek/OpenAI both accept.
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
            return json.loads(args) if isinstance(args, str) else (args or {})
        return json.loads(choice.message.content or "{}")
    except Exception as e:
        logger.warning("tool-call path failed (%s), falling back to json_object mode", e)
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
        return json.loads(resp.choices[0].message.content or "{}")


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
    """Same as chat_text but also returns token usage {prompt, completion, total}."""
    s = get_settings()
    client = make_client()
    mdl = model or s.synthesize_model or s.ai_model
    resp = await client.chat.completions.create(
        model=mdl,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    text = resp.choices[0].message.content or ""
    usage = {
        "prompt_tokens": int(getattr(resp.usage, "prompt_tokens", 0) or 0),
        "completion_tokens": int(getattr(resp.usage, "completion_tokens", 0) or 0),
        "total_tokens": int(getattr(resp.usage, "total_tokens", 0) or 0),
        "model": mdl,
    }
    return text, usage
