"""LLM adapter for career-planner.

Supports two provider families:

* ``anthropic`` — the Messages API, with assistant-prefill for JSON mode.
* ``openai-compatible`` — the Chat Completions API shape used by OpenAI,
  Ollama (local + cloud), Together, Fireworks, OpenRouter, MiniMax, etc.
  JSON mode uses ``response_format: {"type": "json_object"}``.

All LLM calls go through this module — callers should never construct
provider requests directly.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from career_planner.core.workspace import load_config as load_workspace_config

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_API_VERSION = "2023-06-01"

SUPPORTED_PROVIDERS: tuple[str, ...] = ("anthropic", "openai-compatible")


class LLMError(Exception):
    """Base class for LLM-related errors."""


class LLMConfigError(LLMError):
    """LLM is not configured (missing provider, missing API key, etc.)."""


class LLMAPIError(LLMError):
    """API call failed (network error, non-2xx response, malformed body)."""


@dataclass(frozen=True)
class LLMConfig:
    """Resolved LLM configuration ready for a request."""

    provider: str
    base_url: str
    model: str
    api_key: str


def load_config(workspace: Path) -> LLMConfig:
    """Build an :class:`LLMConfig` from the workspace's ``config.yml``.

    Raises :class:`LLMConfigError` when the provider is unsupported, the
    API-key environment variable is set but unbound, or required fields
    are missing. The API key is read from the env var named by
    ``llm.api_key_env`` — keys are never stored in the config file
    itself. For ``openai-compatible``, ``api_key_env`` may be omitted
    entirely (the local Ollama case); the request goes out without an
    ``Authorization`` header.
    """
    raw = load_workspace_config(workspace).get("llm") or {}
    if not isinstance(raw, dict):
        raise LLMConfigError("config.yml `llm:` block is malformed")

    provider = str(raw.get("provider") or "").strip().lower()
    if not provider:
        raise LLMConfigError(
            "no LLM provider configured — set llm.provider in config.yml"
        )
    if provider not in SUPPORTED_PROVIDERS:
        raise LLMConfigError(
            f"unsupported LLM provider '{provider}' — supported: "
            f"{', '.join(SUPPORTED_PROVIDERS)}"
        )

    base_url_raw = str(raw.get("base_url") or "").strip()
    if provider == "anthropic":
        base_url = (base_url_raw or ANTHROPIC_DEFAULT_BASE_URL).rstrip("/")
    else:
        if not base_url_raw:
            raise LLMConfigError(
                f"set llm.base_url in config.yml — required for provider "
                f"'{provider}'"
            )
        base_url = base_url_raw.rstrip("/")

    model = str(raw.get("model") or "").strip()
    if not model:
        raise LLMConfigError("set llm.model in config.yml")

    api_key_env = str(raw.get("api_key_env") or "").strip()
    api_key = ""
    if api_key_env:
        api_key = os.environ.get(api_key_env, "").strip()
        if not api_key:
            raise LLMConfigError(
                f"environment variable {api_key_env} is unset; export it "
                "before running AI-enhanced commands"
            )
    elif provider == "anthropic":
        raise LLMConfigError("set llm.api_key_env in config.yml")

    return LLMConfig(
        provider=provider,
        base_url=base_url,
        model=model,
        api_key=api_key,
    )


def complete(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    json_prefill: bool = False,
    timeout: float = 30.0,
) -> str:
    """Send a completion request and return the assistant's text response.

    When ``json_prefill`` is True the returned text is guaranteed to be
    a JSON-loadable string (via assistant-prefill on Anthropic, or
    ``response_format: json_object`` on OpenAI-compatible endpoints).

    Raises :class:`LLMAPIError` on network or HTTP failure, malformed
    bodies, or empty content blocks.
    """
    if config.provider == "anthropic":
        return _complete_anthropic(
            config,
            system=system,
            user=user,
            max_tokens=max_tokens,
            json_prefill=json_prefill,
            timeout=timeout,
        )
    if config.provider == "openai-compatible":
        return _complete_openai_compatible(
            config,
            system=system,
            user=user,
            max_tokens=max_tokens,
            json_prefill=json_prefill,
            timeout=timeout,
        )
    # load_config validates the provider list, so this branch is defensive.
    raise LLMAPIError(f"unsupported provider '{config.provider}'")


def complete_json(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int = 2000,
    timeout: float = 30.0,
) -> dict[str, Any]:
    """Send a completion expecting a JSON object back, and parse it.

    Wraps :func:`complete` with ``json_prefill=True`` so OpenAI-compatible
    providers see ``response_format: json_object`` and Anthropic gets the
    assistant prefill. The response is trimmed to the first ``{`` … last
    ``}`` substring before parsing — providers occasionally pad the JSON
    with prose despite the instructions.

    Raises :class:`LLMAPIError` on network/API failure, on non-JSON
    output, or when the parsed value isn't a JSON object.
    """
    raw = complete(
        config,
        system=system,
        user=user,
        max_tokens=max_tokens,
        json_prefill=True,
        timeout=timeout,
    )
    text = raw.strip()
    if "{" in text and "}" in text:
        text = text[text.index("{") : text.rindex("}") + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMAPIError(f"LLM returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise LLMAPIError("LLM response is not a JSON object")
    return data


def _post_json(url: str, *, payload: dict[str, Any], headers: dict[str, str], timeout: float) -> dict[str, Any]:
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


def _complete_anthropic(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int,
    json_prefill: bool,
    timeout: float,
) -> str:
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    if json_prefill:
        messages.append({"role": "assistant", "content": "{"})

    payload = {
        "model": config.model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }
    headers = {
        "x-api-key": config.api_key,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
    }
    body = _post_json(
        f"{config.base_url}/messages",
        payload=payload,
        headers=headers,
        timeout=timeout,
    )

    content = body.get("content")
    if not isinstance(content, list) or not content:
        raise LLMAPIError("LLM response has no content blocks")

    text_parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text_parts.append(str(block.get("text") or ""))

    text = "".join(text_parts).strip()
    if json_prefill:
        text = "{" + text
    return text


def _complete_openai_compatible(
    config: LLMConfig,
    *,
    system: str,
    user: str,
    max_tokens: int,
    json_prefill: bool,
    timeout: float,
) -> str:
    payload: dict[str, Any] = {
        "model": config.model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if json_prefill:
        # OpenAI, recent Ollama, Together, vLLM, and most major providers
        # honor this; providers that don't will ignore it and rely on the
        # prompt's "respond with JSON" instruction.
        payload["response_format"] = {"type": "json_object"}

    headers: dict[str, str] = {"content-type": "application/json"}
    if config.api_key:
        headers["authorization"] = f"Bearer {config.api_key}"

    body = _post_json(
        f"{config.base_url}/chat/completions",
        payload=payload,
        headers=headers,
        timeout=timeout,
    )

    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise LLMAPIError("LLM response has no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise LLMAPIError("LLM response missing message in first choice")
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        finish_reason = (
            choices[0].get("finish_reason") if isinstance(choices[0], dict) else None
        )
        if finish_reason == "length":
            reasoning = message.get("reasoning")
            in_reasoning = isinstance(reasoning, str) and reasoning.strip()
            where = "during reasoning " if in_reasoning else ""
            raise LLMAPIError(
                f"model exhausted max_tokens {where}before producing "
                "visible content; increase max_tokens"
            )
        raise LLMAPIError("LLM response has empty message content")
    return content.strip()
