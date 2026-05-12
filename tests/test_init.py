"""Tests for `career init`."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
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
    assert (ws / "profile.yml").is_file()
    assert (ws / "criteria.yml").is_file()
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
    profile = yaml.safe_load((ws / "profile.yml").read_text(encoding="utf-8"))
    criteria = yaml.safe_load((ws / "criteria.yml").read_text(encoding="utf-8"))
    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text(encoding="utf-8"))

    assert config["language"] == "en"
    assert "llm" in config and "data" in config and "mcp" in config

    assert {"name", "current_role", "target_role", "history"} <= profile.keys()

    assert {"function", "culture", "growth", "compensation", "location"} <= criteria.keys()
    assert "dealbreakers" in criteria["function"]

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
