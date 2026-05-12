"""Tests for the profile module and the `career profile` CLI."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import profile as profile_cmd
from career_planner.core import profile as profile_core
from career_planner.core.workspace import create_workspace, load_config

runner = CliRunner()


# --- core/profile.py ---


def test_profile_path_points_at_workspace_root(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert profile_core.profile_path(ws) == ws / "profile.yml"


def test_load_profile_returns_empty_dict_when_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    assert profile_core.load_profile(ws) == {}


def test_load_profile_reads_template_after_init(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    data = profile_core.load_profile(ws)
    assert "name" in data
    assert "current_role" in data
    assert "history" in data


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    payload = {"name": "Bob", "values": ["learning", "impact"]}
    profile_core.save_profile(ws, payload)
    assert profile_core.load_profile(ws) == payload


def test_resolve_editor_prefers_config_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDITOR", raising=False)
    assert profile_core.resolve_editor({"editor": "nano"}) == "nano"


def test_resolve_editor_treats_placeholder_as_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDITOR", "code --wait")
    assert profile_core.resolve_editor({"editor": "$EDITOR"}) == "code --wait"


def test_resolve_editor_falls_back_to_vim(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDITOR", raising=False)
    assert profile_core.resolve_editor({"editor": "$EDITOR"}) == "vim"
    assert profile_core.resolve_editor({}) == "vim"
    assert profile_core.resolve_editor(None) == "vim"


def test_resolve_editor_uses_env_when_no_config_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDITOR", "emacs")
    assert profile_core.resolve_editor({}) == "emacs"


def test_open_in_editor_raises_when_binary_missing() -> None:
    with pytest.raises(FileNotFoundError):
        profile_core.open_in_editor(
            Path("/tmp/whatever"), "definitely-not-a-real-editor-zzz"
        )


def test_open_in_editor_invokes_subprocess(tmp_path: Path) -> None:
    target = tmp_path / "profile.yml"
    target.touch()
    fake = type("R", (), {"returncode": 0})()
    with patch("career_planner.core.profile.subprocess.run", return_value=fake) as run:
        with patch(
            "career_planner.core.profile.shutil.which", return_value="/usr/bin/vim"
        ):
            rc = profile_core.open_in_editor(target, "vim")
    assert rc == 0
    run.assert_called_once_with(["vim", str(target)])


# --- workspace.load_config ---


def test_load_config_reads_initialized_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws, language="vi")
    config = load_config(ws)
    assert config.get("language") == "vi"
    assert isinstance(config.get("llm"), dict)


# --- CLI: career profile show ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_profile_show_empty_template(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["profile", "show"])
    assert result.exit_code == 0, result.output
    assert "empty" in result.output.lower()


def test_cli_profile_show_renders_filled_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {
            "name": "Alice Liddell",
            "current_role": "Software Engineer",
            "current_company": "Acme Corp",
            "years_experience": 4,
            "target_role": "Staff Engineer",
            "target_timeline": "2-3 years",
            "values": ["learning", "impact"],
            "constraints": ["needs visa sponsorship"],
            "history": [
                {
                    "role": "Junior Engineer",
                    "company": "Globex",
                    "start": "2022-01",
                    "end": "2024-06",
                    "summary": "Built internal tools",
                },
            ],
            "goals": ["Tech lead in 3 years"],
        },
    )
    result = runner.invoke(app, ["profile", "show"])
    assert result.exit_code == 0, result.output
    out = result.output
    assert "Alice Liddell" in out
    assert "Software Engineer" in out
    assert "Acme Corp" in out
    assert "Staff Engineer" in out
    assert "learning" in out
    assert "needs visa sponsorship" in out
    assert "Junior Engineer" in out
    assert "Globex" in out
    assert "Tech lead in 3 years" in out


def test_cli_profile_show_omits_empty_sections(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {
            "name": "Sole Field",
            "values": [],
            "constraints": [],
            "history": [],
            "goals": [],
        },
    )
    result = runner.invoke(app, ["profile", "show"])
    assert result.exit_code == 0, result.output
    out = result.output
    assert "Sole Field" in out
    assert "Values" not in out
    assert "Constraints" not in out
    assert "Career history" not in out


def test_cli_profile_show_outside_workspace_exits_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["profile", "show"])
    assert result.exit_code == 2


# --- CLI: career profile edit --editor (raw YAML mode) ---


def test_cli_profile_edit_editor_invokes_editor_on_profile_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    calls: list[tuple[Path, str]] = []

    def fake_open(file_path: Path, editor: str) -> int:
        calls.append((file_path, editor))
        return 0

    with patch.object(profile_cmd.profile_core, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(app, ["profile", "edit", "--editor"])

    assert result.exit_code == 0, result.output
    assert len(calls) == 1
    captured_path, captured_editor = calls[0]
    assert captured_path == ws / "profile.yml"
    assert captured_editor == "stub-editor"


def test_cli_profile_edit_editor_uses_config_editor_when_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.delenv("EDITOR", raising=False)
    config_path = ws / "config.yml"
    config_path.write_text(
        yaml.safe_dump({"language": "en", "editor": "nano"}),
        encoding="utf-8",
    )

    captured: dict[str, str] = {}

    def fake_open(file_path: Path, editor: str) -> int:
        captured["editor"] = editor
        return 0

    with patch.object(profile_cmd.profile_core, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(app, ["profile", "edit", "--editor"])

    assert result.exit_code == 0, result.output
    assert captured["editor"] == "nano"


def test_cli_profile_edit_editor_reports_missing_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)

    with patch.object(
        profile_cmd.profile_core,
        "open_in_editor",
        side_effect=FileNotFoundError("missing"),
    ):
        result = runner.invoke(app, ["profile", "edit", "--editor"])

    assert result.exit_code == 1
    assert "editor" in result.output.lower()


def test_cli_profile_edit_editor_propagates_nonzero_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(profile_cmd.profile_core, "open_in_editor", return_value=2):
        result = runner.invoke(app, ["profile", "edit", "--editor"])

    assert result.exit_code == 2


def test_cli_profile_edit_outside_workspace_exits_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["profile", "edit"], input="\n" * 20)
    assert result.exit_code == 2
    result_editor = runner.invoke(app, ["profile", "edit", "--editor"])
    assert result_editor.exit_code == 2


# --- CLI: career profile edit (interactive default) ---


def test_cli_profile_edit_interactive_fills_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    inputs = (
        "Norah Hoang\n"           # name
        "Software Engineer\n"     # current_role
        "Acme Corp\n"             # current_company
        "3\n"                     # years_experience
        "Staff Engineer\n"        # target_role
        "2-3 years\n"             # target_timeline
        "impact, learning, autonomy\n"  # values
        "needs visa\n"            # constraints
        "tech lead\n"             # goals
        "n\n"                     # confirm: add past role?
    )
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output

    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert data["name"] == "Norah Hoang"
    assert data["current_role"] == "Software Engineer"
    assert data["current_company"] == "Acme Corp"
    assert data["years_experience"] == 3
    assert data["target_role"] == "Staff Engineer"
    assert data["target_timeline"] == "2-3 years"
    assert data["values"] == ["impact", "learning", "autonomy"]
    assert data["constraints"] == ["needs visa"]
    assert data["goals"] == ["tech lead"]
    assert data["history"] == []


def test_cli_profile_edit_interactive_keeps_defaults_on_blank_enter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {
            "name": "Norah",
            "current_role": "SWE",
            "current_company": "Acme",
            "years_experience": 4,
            "target_role": "Staff",
            "target_timeline": "2 years",
            "values": ["impact"],
            "constraints": [],
            "goals": ["lead a team"],
            "history": [],
        },
    )
    inputs = "\n" * 9 + "n\n"
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output

    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert data["name"] == "Norah"
    assert data["years_experience"] == 4
    assert data["values"] == ["impact"]
    assert data["goals"] == ["lead a team"]


def test_cli_profile_edit_interactive_preserves_existing_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {
            "name": "Norah",
            "history": [
                {
                    "role": "Junior Engineer",
                    "company": "Globex",
                    "start": "2022-01",
                    "end": "2024-06",
                    "summary": "Built internal tools",
                }
            ],
        },
    )
    inputs = "\n" * 9 + "n\n"
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output

    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert len(data["history"]) == 1
    assert data["history"][0]["role"] == "Junior Engineer"
    assert data["history"][0]["company"] == "Globex"
    # Existing history details survive a no-op edit unchanged
    assert "Existing history" in result.output


def test_cli_profile_edit_interactive_appends_history_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    inputs = (
        "\n" * 9                  # default all scalars + lists
        + "y\n"                   # add a past role
        + "Junior Eng\n"
        + "Globex\n"
        + "2022-01\n"
        + "2024-06\n"
        + "Built internal tools\n"
        + "n\n"                   # stop adding
    )
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output

    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert len(data["history"]) == 1
    entry = data["history"][0]
    assert entry["role"] == "Junior Eng"
    assert entry["company"] == "Globex"
    assert entry["start"] == "2022-01"
    assert entry["end"] == "2024-06"
    assert entry["summary"] == "Built internal tools"


def test_cli_profile_edit_interactive_dash_clears_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {"values": ["a", "b"], "constraints": ["x"], "goals": []},
    )
    inputs = (
        "\n" * 6        # 6 scalars default
        + "-\n"         # clear values
        + "\n"          # constraints default
        + "\n"          # goals default
        + "n\n"         # no history
    )
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output

    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert data["values"] == []
    assert data["constraints"] == ["x"]


def test_cli_profile_edit_interactive_rejects_non_numeric_years(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    inputs = (
        "\n"            # name
        + "\n"          # current_role
        + "\n"          # current_company
        + "not a number\n"  # years_experience — reprompt
        + "5\n"             # years_experience — accepted
        + "\n"          # target_role
        + "\n"          # target_timeline
        + "\n\n\n"      # values, constraints, goals
        + "n\n"
    )
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output
    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert data["years_experience"] == 5
    assert "whole number" in result.output.lower()


def test_cli_profile_edit_interactive_unknown_fields_survive(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    profile_core.save_profile(
        ws,
        {"name": "Norah", "favourite_color": "amber"},
    )
    inputs = "\n" * 9 + "n\n"
    result = runner.invoke(app, ["profile", "edit"], input=inputs)
    assert result.exit_code == 0, result.output
    data = yaml.safe_load((ws / "profile.yml").read_text())
    assert data["favourite_color"] == "amber"
