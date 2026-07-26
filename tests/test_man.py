"""Tests for `career man`."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import man as man_cmd

runner = CliRunner()


def test_read_man_page_returns_full_manual() -> None:
    content = man_cmd._read_man_page()
    assert "Career Planner Manual" in content
    assert "SYNOPSIS" in content
    assert "career init" in content


def test_read_man_page_raises_when_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        man_cmd.resources,
        "files",
        lambda _pkg: (_ for _ in ()).throw(ModuleNotFoundError()),
    )
    monkeypatch.setattr(
        man_cmd.Path,
        "is_file",
        lambda self: False,
    )
    with pytest.raises(FileNotFoundError):
        man_cmd._read_man_page()


def test_cli_man_outputs_manual_content() -> None:
    result = runner.invoke(app, ["man"])
    assert result.exit_code == 0, result.output
    # Rich-rendered markdown strips ANSI in non-TTY mode but the text persists.
    assert "career" in result.output.lower()
    assert "SYNOPSIS" in result.output
    assert "init" in result.output


def test_cli_man_no_pager_flag_runs_cleanly() -> None:
    result = runner.invoke(app, ["man", "--no-pager"])
    assert result.exit_code == 0, result.output
    assert "SYNOPSIS" in result.output


def test_cli_man_reports_missing_manual(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        man_cmd, "_read_man_page", lambda: (_ for _ in ()).throw(FileNotFoundError())
    )
    result = runner.invoke(app, ["man"])
    assert result.exit_code == 1
    assert "not found" in result.output.lower()


def test_repo_docs_man_matches_runtime_output() -> None:
    """The runtime man page should mirror docs/man.md in editable installs."""
    repo_doc = Path(__file__).resolve().parents[1] / "docs" / "man.md"
    if not repo_doc.is_file():
        pytest.skip("docs/man.md not available (non-editable install)")
    assert man_cmd._read_man_page() == repo_doc.read_text(encoding="utf-8")
