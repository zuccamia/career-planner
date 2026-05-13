"""LLM adapter for career-planner.

Supports Anthropic's Messages API. All LLM calls go through this module —
callers should never construct provider requests directly. Additional
providers (OpenAI-compatible, Ollama) can land here without changing the
public surface (:class:`LLMConfig`, :func:`load_config`, :func:`complete`).
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

SUPPORTED_PROVIDERS: tuple[str, ...] = ("anthropic",)


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
    API-key environment variable is unset, or required fields are missing.
    The API key is read from the env var named by ``llm.api_key_env`` —
    keys are never stored in the config file itself.
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
            f"unsupported LLM provider '{provider}' — only "
            f"{', '.join(SUPPORTED_PROVIDERS)} is implemented in this build"
        )

    base_url = str(raw.get("base_url") or ANTHROPIC_DEFAULT_BASE_URL).rstrip("/")
    model = str(raw.get("model") or "").strip()
    if not model:
        raise LLMConfigError("set llm.model in config.yml")

    api_key_env = str(raw.get("api_key_env") or "").strip()
    if not api_key_env:
        raise LLMConfigError("set llm.api_key_env in config.yml")
    api_key = os.environ.get(api_key_env, "").strip()
    if not api_key:
        raise LLMConfigError(
            f"environment variable {api_key_env} is unset; export it before "
            "running AI-enhanced commands"
        )

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

    When ``json_prefill`` is True the assistant message is primed with
    ``{`` so the model's output is forced to start a JSON object; the
    returned text is then re-prepended with ``{`` so callers can pass it
    straight to ``json.loads``.

    Raises :class:`LLMAPIError` on network or HTTP failure, malformed
    bodies, or empty content blocks.
    """
    messages: list[dict[str, Any]] = [{"role": "user", "content": user}]
    if json_prefill:
        messages.append({"role": "assistant", "content": "{"})

    payload = {
        "model": config.model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    }

    try:
        response = httpx.post(
            f"{config.base_url}/messages",
            json=payload,
            headers={
                "x-api-key": config.api_key,
                "anthropic-version": ANTHROPIC_API_VERSION,
                "content-type": "application/json",
            },
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise LLMAPIError(f"network error contacting LLM: {exc}") from exc

    if response.status_code >= 400:
        snippet = response.text[:200] if response.text else "(empty body)"
        raise LLMAPIError(
            f"LLM API returned {response.status_code}: {snippet}"
        )

    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise LLMAPIError(f"LLM returned non-JSON body: {exc}") from exc

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
