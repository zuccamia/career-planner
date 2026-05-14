"""Tests for the skills inventory module and the `career skills` CLI."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import skills as skills_core
from career_planner.core.workspace import create_workspace

runner = CliRunner()


# --- core/skills.py ---


def test_load_inventory_returns_empty_for_fresh_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert skills_core.load_inventory(ws) == []


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    entry = skills_core.make_entry(
        label="Haskell",
        esco_code="http://example/skill/1",
        rating=4,
        example="Shipped a parser",
        added=date(2026, 5, 11),
    )
    skills_core.save_inventory(ws, [entry])

    loaded = skills_core.load_inventory(ws)
    assert loaded == [entry]


def test_make_entry_omits_esco_code_when_freeform() -> None:
    entry = skills_core.make_entry(
        label="Tarot reading", esco_code=None, rating=3, example="x"
    )
    assert "esco_code" not in entry
    assert entry["skill"] == "Tarot reading"
    assert entry["rating"] == 3


def test_is_duplicate_detects_by_label_and_code() -> None:
    inv = [
        {"skill": "Haskell", "esco_code": "http://example/skill/1", "rating": 4},
    ]
    assert skills_core.is_duplicate(inv, "haskell", None)
    assert skills_core.is_duplicate(inv, "different", "http://example/skill/1")
    assert not skills_core.is_duplicate(inv, "Erlang", None)


def test_find_in_inventory_prefers_exact_over_substring() -> None:
    inv = [
        {"skill": "Python (computer programming)"},
        {"skill": "Python"},
    ]
    matches = skills_core.find_in_inventory(inv, "python")
    assert [entry["skill"] for entry in matches] == ["Python"]


def test_find_in_inventory_returns_substring_when_no_exact() -> None:
    inv = [
        {"skill": "Python (computer programming)"},
        {"skill": "Haskell"},
    ]
    matches = skills_core.find_in_inventory(inv, "python")
    assert len(matches) == 1
    assert matches[0]["skill"] == "Python (computer programming)"


# --- CLI: career skills add/list/remove ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_skills_add_with_esco_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        [
            "skills",
            "add",
            "Haskell",
            "--rating",
            "4",
            "--example",
            "Built a parser in 200 lines",
        ],
    )
    assert result.exit_code == 0, result.output

    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text())["skills"]
    assert len(inventory) == 1
    entry = inventory[0]
    assert entry["skill"] == "Haskell"
    assert entry["rating"] == 4
    assert entry["example"] == "Built a parser in 200 lines"
    assert entry["esco_code"].startswith("http://data.europa.eu/esco/skill/")
    assert "added" in entry


def test_cli_skills_add_freeform_when_no_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        [
            "skills",
            "add",
            "zzz-invented-skill-name-xyz",
            "--rating",
            "2",
            "--example",
            "Made it up",
        ],
    )
    assert result.exit_code == 0, result.output

    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text())["skills"]
    assert len(inventory) == 1
    assert inventory[0]["skill"] == "zzz-invented-skill-name-xyz"
    assert "esco_code" not in inventory[0]


def test_cli_skills_add_rejects_duplicate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    args = [
        "skills",
        "add",
        "Haskell",
        "--rating",
        "4",
        "--example",
        "first",
    ]
    first = runner.invoke(app, args)
    assert first.exit_code == 0, first.output
    second = runner.invoke(app, args)
    assert second.exit_code == 1
    assert "already" in second.output.lower()


def test_cli_skills_add_prompts_for_rating_and_example(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        ["skills", "add", "Haskell"],
        input="3\nLed Haskell study group\n",
    )
    assert result.exit_code == 0, result.output

    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text())["skills"]
    assert inventory[0]["rating"] == 3
    assert inventory[0]["example"] == "Led Haskell study group"


def test_cli_skills_list_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["skills", "list"])
    assert result.exit_code == 0, result.output
    assert "empty" in result.output.lower()


def test_cli_skills_list_renders_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(
        app,
        [
            "skills",
            "add",
            "Haskell",
            "--rating",
            "4",
            "--example",
            "Built a parser",
        ],
    )
    result = runner.invoke(app, ["skills", "list"])
    assert result.exit_code == 0, result.output
    assert "Haskell" in result.output
    assert "Built a parser" in result.output


def test_cli_skills_list_filters_by_category(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(
        app,
        ["skills", "add", "Haskell", "--rating", "4", "--example", "x"],
    )
    runner.invoke(
        app,
        [
            "skills",
            "add",
            "zzz-invented-skill",
            "--rating",
            "2",
            "--example",
            "y",
        ],
    )

    matched = runner.invoke(app, ["skills", "list", "--category", "knowledge"])
    assert matched.exit_code == 0, matched.output
    assert "Haskell" in matched.output
    assert "zzz-invented-skill" not in matched.output

    empty = runner.invoke(
        app, ["skills", "list", "--category", "no-such-category-xyz"]
    )
    assert empty.exit_code == 0
    assert "no skills matched" in empty.output.lower()


def test_cli_skills_remove_existing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    runner.invoke(
        app,
        ["skills", "add", "Haskell", "--rating", "4", "--example", "x"],
    )
    result = runner.invoke(app, ["skills", "remove", "Haskell"])
    assert result.exit_code == 0, result.output
    inventory = yaml.safe_load((ws / "skills" / "inventory.yml").read_text())["skills"]
    assert inventory == []


def test_cli_skills_remove_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(
        app,
        ["skills", "add", "Haskell", "--rating", "4", "--example", "x"],
    )
    result = runner.invoke(app, ["skills", "remove", "Erlang"])
    assert result.exit_code == 1
    assert "no skill matching" in result.output.lower()


def test_cli_skills_remove_empty_inventory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["skills", "remove", "Haskell"])
    assert result.exit_code == 1
    assert "empty" in result.output.lower()


def test_cli_skills_add_outside_workspace_exits_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(
        app,
        ["skills", "add", "Haskell", "--rating", "4", "--example", "x"],
    )
    assert result.exit_code == 2
