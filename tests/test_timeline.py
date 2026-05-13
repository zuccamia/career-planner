"""Tests for the `career timeline` command."""

from __future__ import annotations

from datetime import date
from pathlib import Path

from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import timeline as timeline_cmd
from career_planner.core import profile as profile_core
from career_planner.core.workspace import create_workspace

runner = CliRunner()


def _write_profile(workspace: Path, data: dict) -> None:
    profile_core.save_profile(workspace, data)


# --- pure helpers ---


def test_parse_year_month_accepts_padded_and_unpadded() -> None:
    assert timeline_cmd._parse_year_month("2020-01") == (2020, 1)
    assert timeline_cmd._parse_year_month("2020-1") == (2020, 1)


def test_parse_year_month_rejects_garbage() -> None:
    assert timeline_cmd._parse_year_month("") is None
    assert timeline_cmd._parse_year_month("present") is None
    assert timeline_cmd._parse_year_month("2020-13") is None
    assert timeline_cmd._parse_year_month("2020") is None


def test_format_duration_years_and_months() -> None:
    today = date(2026, 5, 13)
    assert (
        timeline_cmd._format_duration((2020, 1), (2022, 7), today, present=False)
        == "2y 6m"
    )


def test_format_duration_years_only() -> None:
    today = date(2026, 5, 13)
    assert (
        timeline_cmd._format_duration((2020, 1), (2023, 1), today, present=False)
        == "3y"
    )


def test_format_duration_months_only() -> None:
    today = date(2026, 5, 13)
    assert (
        timeline_cmd._format_duration((2024, 1), (2024, 5), today, present=False)
        == "4m"
    )


def test_format_duration_present_uses_today() -> None:
    today = date(2026, 5, 13)
    duration = timeline_cmd._format_duration((2024, 5), None, today, present=True)
    assert duration == "2y"


def test_format_duration_returns_blank_when_missing_start() -> None:
    today = date(2026, 5, 13)
    assert (
        timeline_cmd._format_duration(None, (2020, 1), today, present=False) == ""
    )


def test_format_duration_returns_blank_when_negative() -> None:
    today = date(2026, 5, 13)
    assert (
        timeline_cmd._format_duration((2024, 1), (2023, 1), today, present=False)
        == ""
    )


# --- CLI output ---


def test_timeline_empty_profile_shows_hint(tmp_path: Path, monkeypatch) -> None:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    monkeypatch.chdir(workspace)

    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 0
    assert "career profile edit" in result.output.lower()


def test_timeline_renders_past_present_and_targets(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    _write_profile(
        workspace,
        {
            "name": "Alex",
            "current_role": "Senior Engineer",
            "current_company": "Initech",
            "target_role": "Staff Engineer",
            "target_timeline": "2-3 years",
            "goals": ["Mentor junior engineers", "Speak at a conference"],
            "history": [
                {
                    "role": "Junior Engineer",
                    "company": "Acme",
                    "start": "2018-06",
                    "end": "2020-12",
                    "summary": "",
                },
                {
                    "role": "Senior Engineer",
                    "company": "Initech",
                    "start": "2023-06",
                    "end": "present",
                    "summary": "",
                },
            ],
        },
    )
    monkeypatch.chdir(workspace)

    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 0
    out = result.output
    assert "Past" in out
    assert "Present" in out
    assert "Targets" in out
    assert "Junior Engineer" in out
    assert "Acme" in out
    assert "2018-06" in out
    assert "2020-12" in out
    assert "Senior Engineer" in out
    assert "Initech" in out
    assert "Staff Engineer" in out
    assert "2-3 years" in out
    assert "Mentor junior engineers" in out


def test_timeline_falls_back_to_current_role_when_no_present_history(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    _write_profile(
        workspace,
        {
            "current_role": "Software Engineer",
            "current_company": "Globex",
        },
    )
    monkeypatch.chdir(workspace)

    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 0
    assert "Present" in result.output
    assert "Software Engineer" in result.output
    assert "Globex" in result.output


def test_timeline_sorts_past_chronologically(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    _write_profile(
        workspace,
        {
            "history": [
                {"role": "Third", "company": "C", "start": "2022-01", "end": "2023-01"},
                {"role": "First", "company": "A", "start": "2018-01", "end": "2020-01"},
                {"role": "Second", "company": "B", "start": "2020-02", "end": "2021-12"},
            ],
        },
    )
    monkeypatch.chdir(workspace)

    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 0
    first_idx = result.output.index("First")
    second_idx = result.output.index("Second")
    third_idx = result.output.index("Third")
    assert first_idx < second_idx < third_idx


def test_timeline_handles_unknown_start_end(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    _write_profile(
        workspace,
        {
            "history": [
                {"role": "Engineer", "company": "Acme", "start": "", "end": ""},
            ],
        },
    )
    monkeypatch.chdir(workspace)

    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 0
    assert "Engineer" in result.output
    assert "?" in result.output


def test_timeline_outside_workspace_exits_two(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["timeline"])
    assert result.exit_code == 2