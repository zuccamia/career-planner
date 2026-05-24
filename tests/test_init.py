"""Tests for `career init` and workspace-level helpers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import workspace as workspace_core
from career_planner.core.workspace import (
    WORKSPACE_SUBDIRS,
    WorkspaceExistsError,
    create_workspace,
    find_workspace,
)

runner = CliRunner()


def test_create_workspace_writes_directory_tree(tmp_path: Path) -> None:
    ws = tmp_path / "my-career"
    create_workspace(ws)

    assert (ws / "config.yml").is_file()
    assert (ws / "criteria.yml").is_file()
    assert (ws / "resume.yml").is_file()
    assert (ws / "skills" / "inventory.yml").is_file()

    for sub in WORKSPACE_SUBDIRS:
        assert (ws / sub).is_dir(), f"missing subdir: {sub}"


def test_create_workspace_copies_coaching_files(tmp_path: Path) -> None:
    ws = tmp_path / "my-career"
    create_workspace(ws)

    system_prompt = ws / "data" / "coaching" / "system-prompt.md"
    policies = ws / "data" / "coaching" / "policies.md"
    assert system_prompt.is_file()
    assert policies.is_file()
    # Sanity check: prompt template references a known placeholder.
    assert "{{name}}" in system_prompt.read_text(encoding="utf-8")


def test_create_workspace_starter_files_are_valid_yaml(tmp_path: Path) -> None:
    ws = tmp_path / "my-career"
    create_workspace(ws)

    config = yaml.safe_load((ws / "config.yml").read_text(encoding="utf-8"))
    criteria = yaml.safe_load((ws / "criteria.yml").read_text(encoding="utf-8"))
    resume = yaml.safe_load((ws / "resume.yml").read_text(encoding="utf-8"))
    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text(encoding="utf-8"))

    assert config["language"] == "en"
    assert "llm" in config and "data" in config and "mcp" in config

    assert {"function", "culture", "growth", "compensation", "location"} <= criteria.keys()
    assert "dealbreakers" in criteria["function"]

    assert {"header", "target", "objective", "experience", "education", "extras"} <= resume.keys()

    assert inventory == {"skills": []}


def test_create_workspace_respects_language_option(tmp_path: Path) -> None:
    ws = tmp_path / "vi-career"
    create_workspace(ws, language="vi")

    config = yaml.safe_load((ws / "config.yml").read_text(encoding="utf-8"))
    assert config["language"] == "vi"


def test_create_workspace_refuses_existing_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "my-career"
    create_workspace(ws)

    with pytest.raises(WorkspaceExistsError) as excinfo:
        create_workspace(ws)
    assert excinfo.value.path == ws.resolve()


def test_find_workspace_finds_newly_created_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "my-career"
    create_workspace(ws)

    found = find_workspace(ws / "skills")
    assert found == ws.resolve()


def test_cli_init_in_named_subdirectory(tmp_path: Path) -> None:
    result = runner.invoke(app, ["init", str(tmp_path / "my-career")])
    assert result.exit_code == 0, result.output
    assert (tmp_path / "my-career" / "config.yml").is_file()


def test_cli_init_in_current_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["init"])
    assert result.exit_code == 0, result.output
    assert (tmp_path / "config.yml").is_file()


def test_cli_init_fails_when_workspace_exists(tmp_path: Path) -> None:
    target = tmp_path / "my-career"
    create_workspace(target)

    result = runner.invoke(app, ["init", str(target)])
    assert result.exit_code == 1
    assert "exists" in result.output.lower()


def test_cli_init_rejects_unsupported_language(tmp_path: Path) -> None:
    result = runner.invoke(
        app, ["init", str(tmp_path / "x"), "--language", "klingon"]
    )
    assert result.exit_code == 1
    assert "klingon" in result.output


def test_cli_init_language_flag_sets_config(tmp_path: Path) -> None:
    target = tmp_path / "vi-career"
    result = runner.invoke(app, ["init", str(target), "--language", "vi"])
    assert result.exit_code == 0, result.output
    config = yaml.safe_load((target / "config.yml").read_text(encoding="utf-8"))
    assert config["language"] == "vi"


# --- workspace editor helpers ---


def test_resolve_editor_prefers_config_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDITOR", raising=False)
    assert workspace_core.resolve_editor({"editor": "nano"}) == "nano"


def test_resolve_editor_treats_placeholder_as_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDITOR", "code --wait")
    assert workspace_core.resolve_editor({"editor": "$EDITOR"}) == "code --wait"


def test_resolve_editor_falls_back_to_vim(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDITOR", raising=False)
    assert workspace_core.resolve_editor({"editor": "$EDITOR"}) == "vim"
    assert workspace_core.resolve_editor({}) == "vim"
    assert workspace_core.resolve_editor(None) == "vim"


def test_resolve_editor_uses_env_when_no_config_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDITOR", "emacs")
    assert workspace_core.resolve_editor({}) == "emacs"


def test_open_in_editor_raises_when_binary_missing() -> None:
    with pytest.raises(FileNotFoundError):
        workspace_core.open_in_editor(
            Path("/tmp/whatever"), "definitely-not-a-real-editor-zzz"
        )


def test_open_in_editor_invokes_subprocess(tmp_path: Path) -> None:
    target = tmp_path / "file.yml"
    target.touch()
    fake = type("R", (), {"returncode": 0})()
    with patch("career_planner.core.workspace.editor.subprocess.run", return_value=fake) as run:
        with patch(
            "career_planner.core.workspace.editor.shutil.which", return_value="/usr/bin/vim"
        ):
            rc = workspace_core.open_in_editor(target, "vim")
    assert rc == 0
    run.assert_called_once_with(["vim", str(target)])
