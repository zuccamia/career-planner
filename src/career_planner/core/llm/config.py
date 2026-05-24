"""LLM configuration and exceptions."""

from __future__ import annotations

import os
from dataclasses import dataclass
from dotenv import dotenv_values
from pathlib import Path

from career_planner.core.workspace import load_config as load_workspace_config

SUPPORTED_PROVIDERS: tuple[str, ...] = ("anthropic", "openai-compatible")
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
_PLACEHOLDER_API_KEY = "your_key_here"


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


def _is_placeholder_secret(value: str) -> bool:
    return value.strip().strip("\"'").lower() == _PLACEHOLDER_API_KEY


def _load_llm_block(workspace: Path) -> dict[str, object]:
    raw = load_workspace_config(workspace).get("llm") or {}
    if not isinstance(raw, dict):
        raise LLMConfigError("config.yml `llm:` block is malformed")
    return raw


def _resolve_provider(raw: dict[str, object]) -> str:
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
    return provider


def _resolve_base_url(raw: dict[str, object], provider: str) -> str:
    base_url_raw = str(raw.get("base_url") or "").strip()
    if provider == "anthropic":
        return (base_url_raw or ANTHROPIC_DEFAULT_BASE_URL).rstrip("/")
    if not base_url_raw:
        raise LLMConfigError(
            f"set llm.base_url in config.yml — required for provider "
            f"'{provider}'"
        )
    return base_url_raw.rstrip("/")


def _resolve_model(raw: dict[str, object]) -> str:
    model = str(raw.get("model") or "").strip()
    if not model:
        raise LLMConfigError("set llm.model in config.yml")
    return model


def _read_secret(workspace_env: dict[str, str | None], env_name: str) -> str:
    value = workspace_env.get(env_name) or os.environ.get(env_name, "").strip()
    if not value:
        return ""
    return "" if _is_placeholder_secret(value) else value


def _resolve_api_key(raw: dict[str, object], provider: str, workspace: Path) -> str:
    workspace_env = dotenv_values(workspace / ".env")
    api_key_env = str(raw.get("api_key_env") or "").strip()

    if not api_key_env:
        if provider == "anthropic":
            raise LLMConfigError("set llm.api_key_env in config.yml")
        return ""

    api_key = _read_secret(workspace_env, api_key_env)
    if not api_key:
        raise LLMConfigError(
            f"environment variable {api_key_env} is unset; export it "
            "or update configure your key in .env "
            "before running AI-enhanced commands"
        )
    return api_key


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
    raw = _load_llm_block(workspace)
    provider = _resolve_provider(raw)
    base_url = _resolve_base_url(raw, provider)
    model = _resolve_model(raw)
    api_key = _resolve_api_key(raw, provider, workspace)

    return LLMConfig(
        provider=provider,
        base_url=base_url,
        model=model,
        api_key=api_key,
    )