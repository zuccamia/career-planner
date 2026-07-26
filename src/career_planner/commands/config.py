"""`career config` — interactive configuration helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, IntPrompt, Prompt

from career_planner.core import llm as llm_core
from career_planner.core import workspace as workspace_core
from career_planner.i18n import _

console = Console()


@dataclass(frozen=True)
class LLMPreset:
    """A configurable LLM provider preset used by the setup wizard."""

    label: str
    provider: str
    base_url: str
    model_default: str
    api_key_env_default: str
    needs_api_key: bool


PRESETS: tuple[LLMPreset, ...] = (
    LLMPreset(
        label="Anthropic Console",
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model_default="claude-sonnet-4-20250514",
        api_key_env_default="ANTHROPIC_API_KEY",
        needs_api_key=True,
    ),
    LLMPreset(
        label="Ollama Cloud",
        provider="openai-compatible",
        base_url="https://ollama.com/v1",
        model_default="gpt-oss:120b",
        api_key_env_default="OLLAMA_API_KEY",
        needs_api_key=True,
    ),
    LLMPreset(
        label="Local Ollama (no API key)",
        provider="openai-compatible",
        base_url="http://localhost:11434/v1",
        model_default="llama3.1:8b",
        api_key_env_default="",
        needs_api_key=False,
    ),
    LLMPreset(
        label="OpenAI",
        provider="openai-compatible",
        base_url="https://api.openai.com/v1",
        model_default="gpt-4o",
        api_key_env_default="OPENAI_API_KEY",
        needs_api_key=True,
    ),
    LLMPreset(
        label="OpenRouter",
        provider="openai-compatible",
        base_url="https://openrouter.ai/api/v1",
        model_default="anthropic/claude-sonnet-4",
        api_key_env_default="OPENROUTER_API_KEY",
        needs_api_key=True,
    ),
    LLMPreset(
        label="Custom (openai-compatible)",
        provider="openai-compatible",
        base_url="",
        model_default="",
        api_key_env_default="",
        needs_api_key=True,
    ),
)


def setup_llm() -> None:
    """Interactively configure the workspace's LLM provider.

    Prompts the user for a preset, fills in sensible defaults, writes the
    resulting block to ``config.yml`` (preserving other sections and
    comments), and — when the API key env var is already exported, or
    no key is required — runs a tiny connection test automatically.
    Otherwise prints export instructions and points the user at
    ``career config llm test`` for a re-runnable check.
    """
    workspace = workspace_core.require_workspace()
    existing = workspace_core.load_config(workspace).get("llm")
    if isinstance(existing, dict) and existing:
        _show_existing_block(existing)
        if not Confirm.ask(
            _("Replace this configuration?"), default=True, console=console
        ):
            console.print(_("Cancelled."), style="yellow")
            raise typer.Exit(0)

    preset = _prompt_preset()
    block = _prompt_fields(preset)
    workspace_core.save_llm_config(workspace, block)

    console.print(
        Panel(
            "\n".join(
                _llm_block_lines(block)
                + [
                    "",
                    _("Saved to {p}").format(p=workspace / "config.yml"),
                ]
            ),
            title=_("LLM configured"),
            border_style="green",
        )
    )

    _maybe_test(block)


def test_llm() -> None:
    """Send a minimal prompt to the configured LLM and report the result."""
    workspace = workspace_core.require_workspace()
    try:
        config = llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        console.print(
            _("LLM is not configured: {err}").format(err=exc),
            style="red",
        )
        raise typer.Exit(3) from None

    if not _run_ping(config):
        raise typer.Exit(1)


# --- internals ---


def _prompt_preset() -> LLMPreset:
    console.print(_("Choose your LLM provider:"))
    for n, preset in enumerate(PRESETS, 1):
        console.print(f"  {n}. {preset.label}")

    choice = IntPrompt.ask(
        _("Selection"),
        default=1,
        choices=[str(n) for n in range(1, len(PRESETS) + 1)],
        show_choices=False,
        console=console,
    )
    return PRESETS[choice - 1]


def _prompt_fields(preset: LLMPreset) -> dict[str, Any]:
    base_url = Prompt.ask(
        _("Base URL"),
        default=preset.base_url or None,
        console=console,
    ).strip()
    model = Prompt.ask(
        _("Model"),
        default=preset.model_default or None,
        console=console,
    ).strip()
    api_key_env = Prompt.ask(
        _("Env var holding the API key (blank for none)"),
        default=preset.api_key_env_default,
        console=console,
    ).strip()

    block: dict[str, Any] = {
        "provider": preset.provider,
        "base_url": base_url,
        "model": model,
    }
    if api_key_env:
        block["api_key_env"] = api_key_env
    return block


def _show_existing_block(existing: dict[str, Any]) -> None:
    lines = [_("Current llm config:")] + _llm_block_lines(existing)
    console.print(Panel("\n".join(lines), border_style="yellow"))


def _llm_block_lines(block: dict[str, Any]) -> list[str]:
    keys = ("provider", "base_url", "model", "api_key_env")
    return [
        f"  {key}: {block[key]}"
        for key in keys
        if block.get(key)
    ]


def _maybe_test(block: dict[str, Any]) -> None:
    """Test the connection now if we can; otherwise tell the user what to do."""
    api_key_env = block.get("api_key_env") or ""
    if api_key_env and not os.environ.get(api_key_env, "").strip():
        console.print(
            _(
                "\n${env} is not set in this shell. Export it and run "
                "'career config llm test' to verify the connection."
            ).format(env=api_key_env),
            style="yellow",
        )
        return

    if not Confirm.ask(
        _("Test the connection now?"), default=True, console=console
    ):
        return

    workspace = workspace_core.require_workspace()
    try:
        config = llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        console.print(
            _("Cannot test: {err}").format(err=exc), style="yellow"
        )
        return
    _run_ping(config)


def _run_ping(config: llm_core.LLMConfig) -> bool:
    """Send a tiny prompt and report success/failure. Returns True on success."""
    with console.status(
        _("Pinging {model} at {url}…").format(
            model=config.model, url=config.base_url
        )
    ):
        try:
            response = llm_core.complete(
                config,
                system="Respond with the single word: ok",
                user="Are you reachable?",
                max_tokens=500,
            )
        except llm_core.LLMAPIError as exc:
            console.print(
                _("Connection failed: {err}").format(err=exc),
                style="red",
            )
            return False

    snippet = response.strip().replace("\n", " ")[:80] or _("(empty)")
    console.print(
        _("✓ Connected. Model responded: {snippet}").format(snippet=snippet),
        style="green",
    )
    return True
