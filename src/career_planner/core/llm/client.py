"""LLM client — public completion functions.

All LLM calls go through this module. Callers should never construct
provider requests directly.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from career_planner.core.llm.config import LLMAPIError, LLMConfig
from career_planner.core.llm.providers import get_provider
from career_planner.core.llm.tools import TOOLS, dispatch


def _post_json(
    url: str,
    *,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout: float,
) -> dict[str, Any]:
    """Shared HTTP POST → JSON body, with consistent error mapping."""
    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise LLMAPIError(f"network error contacting LLM: {exc}") from exc

    if response.status_code >= 400:
        snippet = response.text[:200] if response.text else "(empty body)"
        raise LLMAPIError(
            f"LLM API returned {response.status_code}: {snippet}"
        )

    try:
        return response.json()
    except json.JSONDecodeError as exc:
        raise LLMAPIError(f"LLM returned non-JSON body: {exc}") from exc

def _parse_json_response(raw: str) -> dict[str, Any]:
    """Extract and parse a JSON object from a raw LLM response string."""
    text = raw.strip()
    if "{" in text and "}" in text:
        text = text[text.index("{"):text.rindex("}") + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMAPIError(f"LLM returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise LLMAPIError("LLM response is not a JSON object")
    return data

def complete(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    json_prefill: bool = False,
    timeout: float = 300.0,
) -> str:
    """Send a completion request and return the assistant's text response.

    When ``json_prefill`` is True the returned text is guaranteed to be
    a JSON-loadable string (via assistant-prefill on Anthropic, or
    ``response_format: json_object`` on OpenAI-compatible endpoints).

    Raises :class:`LLMAPIError` on network or HTTP failure, malformed
    bodies, or empty content blocks.
    """
    p = get_provider(config)
    sys_val, messages = p.wrap_initial_messages(
        system=system, user=user, json_prefill=json_prefill,
    )
    payload = p.build_payload(
        messages=messages,
        system=sys_val,
        max_tokens=max_tokens,
        json_mode=json_prefill,
    )
    body = _post_json(
        p.url(), payload=payload, headers=p.headers(), timeout=timeout,
    )
    text = p.extract_text(body)
    if json_prefill and config.provider == "anthropic":
        text = "{" + text
    return text


def complete_json(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """Send a completion expecting a JSON object back, and parse it.

    Wraps :func:`complete` with ``json_prefill=True`` so OpenAI-compatible
    providers see ``response_format: json_object`` and Anthropic gets the
    assistant prefill.  The response is trimmed to the first ``{`` … last
    ``}`` substring before parsing — providers occasionally pad the JSON
    with prose despite the instructions.

    Raises :class:`LLMAPIError` on network/API failure, on non-JSON
    output, or when the parsed value isn't a JSON object.
    """
    raw = complete(
        config, system=system, user=user,
        max_tokens=max_tokens, json_prefill=True, timeout=timeout,
    )
    return _parse_json_response(raw)


def complete_with_tools(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    max_steps: int = 5,
    timeout: float = 300.0,
) -> str:
    """Send a completion with tool use, looping until a text response.

    The LLM may call tools defined in :mod:`career_planner.core.llm.tools`
    up to ``max_steps`` times.  Each tool call is dispatched locally and
    the result fed back into the conversation.  The loop terminates when
    the model produces a plain text response.

    Raises :class:`LLMAPIError` on network/API failure or if the tool
    loop exceeds ``max_steps`` without a text response.
    """
    p = get_provider(config)
    _, messages = p.wrap_initial_messages(
        system=system, user=user, json_prefill=False,
    )

    for _ in range(max_steps):
        payload = p.build_payload(
            messages=messages,
            system=system,
            max_tokens=max_tokens,
            tools=TOOLS,
        )
        body = _post_json(
            p.url(), payload=payload, headers=p.headers(), timeout=timeout,
        )
        tool_calls = p.extract_tool_calls(body)

        if not tool_calls:
            return p.extract_text(body)

        results = [
            (tid, dispatch(name, args)) for tid, name, args in tool_calls
        ]
        p.append_tool_results(messages, body, results)

    raise LLMAPIError("tool loop exceeded max_steps without a text response")

def complete_json_with_tools(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    max_steps: int = 5,
    timeout: float = 300.0,
) -> dict[str, Any]:
    """Tool-augmented completion that returns a parsed JSON dict.
    
    Falls back to plain complete_json if the provider doesn't support tools.
    """
    raw = complete_with_tools(
        config, system=system, user=user,
        max_tokens=max_tokens, max_steps=max_steps, timeout=timeout,
    )
    return _parse_json_response(raw)
    