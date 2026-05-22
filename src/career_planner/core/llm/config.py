"""LLM configuration and exceptions."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from career_planner.core.workspace import load_config as load_workspace_config

SUPPORTED_PROVIDERS: tuple[str, ...] = ("anthropic", "openai-compatible")
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"


class LLMError(Exception):
    """Base class for LLM-related errors."""

class LLMConfigError(LLMError):
    """LLM is not configured."""

class LLMAPIError(LLMError):
    """API call failed."""
    @property
    def is_tool_support_error(self) -> bool:
        msg = str(self).lower()
        return any(signal in msg for signal in (
            "failed to translate",
            "tools is not supported",
            "tool_use is not supported",
            "unrecognized request argument: tools",
            "does not support tools",
            "invalid parameter: tools",
            "unknown field: tools",
        ))


@dataclass(frozen=True)
class LLMConfig:
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