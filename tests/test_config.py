"""Tests for the `career config llm` setup wizard and connection test."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import typer
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import config as config_cmd
from career_planner.core import llm as llm_core
from career_planner.core import workspace as workspace_core

runner = CliRunner(env={"COLUMNS": "200"})


# --- workspace.save_llm_config: surgical YAML replace ---


def test_save_llm_config_replaces_block_and_preserves_other_sections(
    tmp_path: Path,
) -> None:
    ws = tmp_path / "ws"
    workspace_core.create_workspace(ws)
    # The template ships with an `llm:` block plus `data:`, `mcp:`, etc.
    original = (ws / "config.yml").read_text(encoding="utf-8")
    assert "data:" in original
    assert "mcp:" in original

    workspace_core.save_llm_config(
        ws,
        {
            "provider": "openai-compatible",
            "base_url": "https://ollama.com/v1",
            "model": "gpt-oss:120b",
            "api_key_env": "OLLAMA_API_KEY",
        },
    )
    after = (ws / "config.yml").read_text(encoding="utf-8")

    # Other sections survive the surgery.
    assert "data:" in after
    assert "mcp:" in after
    assert "editor:" in after
    # The leading comment header is preserved.
    assert after.startswith("# Career Planner Configuration")

    # The new llm block parses back to what we wrote.
    parsed = yaml.safe_load(after)
    assert parsed["llm"] == {
        "provider": "openai-compatible",
        "base_url": "https://ollama.com/v1",
        "model": "gpt-oss:120b",
        "api_key_env": "OLLAMA_API_KEY",
    }


def test_save_llm_config_appends_when_no_existing_block(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "config.yml").write_text(
        "language: en\n\ndata:\n  taxonomy: esco\n", encoding="utf-8"
    )
    workspace_core.save_llm_config(
        ws,
        {
            "provider": "anthropic",
            "base_url": "https://api.anthropic.com/v1",
            "model": "claude-sonnet-4-20250514",
            "api_key_env": "ANTHROPIC_API_KEY",
        },
    )
    after = (ws / "config.yml").read_text(encoding="utf-8")
    assert "language: en" in after
    assert "data:" in after
    parsed = yaml.safe_load(after)
    assert parsed["llm"]["provider"] == "anthropic"


def test_save_llm_config_omits_empty_keys(tmp_path: Path) -> None:
    """Local-Ollama-style configs without api_key_env shouldn't emit it."""
    ws = tmp_path / "ws"
    workspace_core.create_workspace(ws)
    workspace_core.save_llm_config(
        ws,
        {
            "provider": "openai-compatible",
            "base_url": "http://localhost:11434/v1",
            "model": "llama3.1:8b",
            "api_key_env": "",
        },
    )
    parsed = yaml.safe_load((ws / "config.yml").read_text(encoding="utf-8"))
    assert parsed["llm"] == {
        "provider": "openai-compatible",
        "base_url": "http://localhost:11434/v1",
        "model": "llama3.1:8b",
    }
    assert "api_key_env" not in parsed["llm"]


# --- setup_llm: preset selection and field prompts ---


def _ws(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    workspace_core.create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_setup_llm_ollama_cloud_preset_writes_block_and_skips_test_when_env_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)

    complete_called = False

    def fake_complete(*args, **kwargs):
        nonlocal complete_called
        complete_called = True
        return "ok"

    with patch.object(config_cmd.IntPrompt, "ask", return_value=2), patch.object(
        config_cmd.Prompt,
        "ask",
        side_effect=[
            "https://ollama.com/v1",
            "gpt-oss:120b",
            "OLLAMA_API_KEY",
        ],
    ), patch.object(config_cmd.Confirm, "ask", return_value=True), patch.object(
        llm_core, "complete", side_effect=fake_complete
    ):
        # Existing template has an llm block — we'll auto-replace.
        config_cmd.setup_llm()

    parsed = yaml.safe_load((ws / "config.yml").read_text(encoding="utf-8"))
    assert parsed["llm"] == {
        "provider": "openai-compatible",
        "base_url": "https://ollama.com/v1",
        "model": "gpt-oss:120b",
        "api_key_env": "OLLAMA_API_KEY",
    }
    # Env var was unset → no auto-test.
    assert complete_called is False


def test_setup_llm_local_ollama_preset_auto_tests(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)

    with patch.object(config_cmd.IntPrompt, "ask", return_value=3), patch.object(
        config_cmd.Prompt,
        "ask",
        side_effect=["http://localhost:11434/v1", "llama3.1:8b", ""],
    ), patch.object(
        config_cmd.Confirm, "ask", side_effect=[True, True]
    ), patch.object(
        llm_core, "complete", return_value="ok"
    ) as mock_complete:
        config_cmd.setup_llm()

    parsed = yaml.safe_load((ws / "config.yml").read_text(encoding="utf-8"))
    assert "api_key_env" not in parsed["llm"]
    # No env-var prerequisite → the auto-test ran.
    assert mock_complete.called


def test_setup_llm_runs_ping_when_env_var_already_exported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ws(tmp_path, monkeypatch)
    monkeypatch.setenv("OLLAMA_API_KEY", "sk-fake")

    with patch.object(config_cmd.IntPrompt, "ask", return_value=2), patch.object(
        config_cmd.Prompt,
        "ask",
        side_effect=[
            "https://ollama.com/v1",
            "gpt-oss:120b",
            "OLLAMA_API_KEY",
        ],
    ), patch.object(
        config_cmd.Confirm, "ask", side_effect=[True, True]
    ), patch.object(
        llm_core, "complete", return_value="ok"
    ) as mock_complete:
        config_cmd.setup_llm()

    assert mock_complete.called


def test_setup_llm_declined_overwrite_leaves_file_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    before = (ws / "config.yml").read_text(encoding="utf-8")

    with patch.object(config_cmd.Confirm, "ask", return_value=False):
        with pytest.raises(typer.Exit) as exc:
            config_cmd.setup_llm()
        assert exc.value.exit_code == 0

    after = (ws / "config.yml").read_text(encoding="utf-8")
    assert before == after


# --- test_llm: standalone connection check ---


def _write_anthropic_config(ws: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace_core.save_llm_config(
        ws,
        {
            "provider": "anthropic",
            "base_url": "https://api.anthropic.com/v1",
            "model": "claude-sonnet-4-20250514",
            "api_key_env": "CAREER_PING_KEY",
        },
    )
    monkeypatch.setenv("CAREER_PING_KEY", "sk-fake")


def test_test_llm_happy_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    _write_anthropic_config(ws, monkeypatch)

    with patch.object(llm_core, "complete", return_value="ok") as mock_complete:
        config_cmd.test_llm()
    assert mock_complete.called


def test_test_llm_missing_config_exits_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    # Wipe the llm block.
    (ws / "config.yml").write_text("language: en\n", encoding="utf-8")
    with pytest.raises(typer.Exit) as exc:
        config_cmd.test_llm()
    assert exc.value.exit_code == 3


def test_test_llm_api_failure_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    _write_anthropic_config(ws, monkeypatch)

    with patch.object(
        llm_core, "complete", side_effect=llm_core.LLMAPIError("HTTP 500")
    ):
        with pytest.raises(typer.Exit) as exc:
            config_cmd.test_llm()
        assert exc.value.exit_code == 1


# --- CLI routing ---


def test_cli_config_llm_test_invokes_test_function(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _ws(tmp_path, monkeypatch)
    _write_anthropic_config(ws, monkeypatch)

    with patch.object(llm_core, "complete", return_value="ok"):
        result = runner.invoke(app, ["config", "llm", "test"])
    assert result.exit_code == 0, result.output
    assert "Connected" in result.output


def test_cli_config_llm_without_subcommand_runs_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ws(tmp_path, monkeypatch)
    monkeypatch.delenv("OLLAMA_API_KEY", raising=False)

    with patch.object(config_cmd.IntPrompt, "ask", return_value=2), patch.object(
        config_cmd.Prompt,
        "ask",
        side_effect=[
            "https://ollama.com/v1",
            "gpt-oss:120b",
            "OLLAMA_API_KEY",
        ],
    ), patch.object(config_cmd.Confirm, "ask", return_value=True):
        result = runner.invoke(app, ["config", "llm"])

    assert result.exit_code == 0, result.output
    assert "LLM configured" in result.output
