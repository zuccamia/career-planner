"""Tests for the brag module and the `career brag` CLI."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import brag as brag_cmd
from career_planner.core import brag as brag_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})


# --- core/brag.py: file I/O ---


def test_brag_dir_points_under_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert brag_core.brag_dir(ws) == ws / "brag"


def test_list_entries_empty_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert brag_core.list_entries(ws) == []


def test_create_entry_writes_file_with_template(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = brag_core.create_entry(
        ws, title="Shipped X", entry_date=date(2026, 5, 1)
    )
    assert path.exists()
    assert path.name == "2026-05-01-shipped-x.md"

    text = path.read_text(encoding="utf-8")
    assert "date: 2026-05-01" in text
    assert "## What (X)" in text
    assert "## How measured (Y)" in text
    assert "## How I did it (Z)" in text


def test_create_entry_appends_suffix_on_collision(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    p1 = brag_core.create_entry(ws, title="Win", entry_date=date(2026, 5, 1))
    p2 = brag_core.create_entry(ws, title="Win", entry_date=date(2026, 5, 1))
    assert p1.name == "2026-05-01-win.md"
    assert p2.name == "2026-05-01-win-2.md"


def test_list_entries_sorts_newest_first(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    brag_core.create_entry(ws, title="Old", entry_date=date(2025, 1, 1))
    brag_core.create_entry(ws, title="Mid", entry_date=date(2026, 1, 1))
    brag_core.create_entry(ws, title="New", entry_date=date(2026, 5, 1))

    entries = brag_core.list_entries(ws)
    titles = [e.title for e in entries]
    assert titles == ["new", "mid", "old"]


def test_list_entries_parses_frontmatter(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    folder = brag_core.brag_dir(ws)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "2026-04-10-shipped.md").write_text(
        "---\n"
        "date: 2026-04-10\n"
        "project: Acme\n"
        "tags: [backend, latency]\n"
        "---\n\n"
        "## What (X)\n\nShipped a thing.\n",
        encoding="utf-8",
    )
    entries = brag_core.list_entries(ws)
    assert len(entries) == 1
    entry = entries[0]
    assert entry.date == date(2026, 4, 10)
    assert entry.project == "Acme"
    assert entry.tags == ("backend", "latency")
    assert "Shipped a thing." in entry.body


def test_list_entries_falls_back_to_filename_date(tmp_path: Path) -> None:
    """Entries without frontmatter date use the filename's YYYY-MM-DD prefix."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    folder = brag_core.brag_dir(ws)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "2026-03-15-nofront.md").write_text(
        "## What (X)\n\nNo frontmatter here.\n",
        encoding="utf-8",
    )
    entries = brag_core.list_entries(ws)
    assert len(entries) == 1
    assert entries[0].date == date(2026, 3, 15)


def test_load_entry_returns_none_when_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert brag_core.load_entry(ws, "nope") is None


def test_find_entries_matches_by_slug_substring(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    brag_core.create_entry(ws, title="Shipped feature X", entry_date=date(2026, 5, 1))
    brag_core.create_entry(ws, title="Performance work", entry_date=date(2026, 4, 1))

    matches = brag_core.find_entries(ws, "shipped")
    assert len(matches) == 1
    assert "shipped" in matches[0].slug


def test_find_entries_exact_slug_wins_over_substring(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    brag_core.create_entry(ws, title="Win A", entry_date=date(2026, 5, 1))
    brag_core.create_entry(ws, title="Win B", entry_date=date(2026, 5, 1))

    matches = brag_core.find_entries(ws, "2026-05-01-win-a")
    assert len(matches) == 1
    assert matches[0].slug == "2026-05-01-win-a"


def test_brag_entry_title_strips_date_prefix(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    brag_core.create_entry(
        ws, title="Cut Latency 30%", entry_date=date(2026, 5, 1)
    )
    entry = brag_core.list_entries(ws)[0]
    assert entry.title == "cut latency 30"


# --- CLI: career brag add ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_brag_add_creates_entry_and_opens_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    captured: list[Path] = []

    def fake_open(file_path: Path, editor: str) -> int:
        captured.append(file_path)
        return 0

    with patch.object(brag_cmd, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(
            app,
            ["brag", "add", "Shipped X", "--date", "2026-05-01"],
            input="\n",  # accept the empty default for the tags prompt
        )

    assert result.exit_code == 0, result.output
    assert len(captured) == 1
    assert captured[0].name == "2026-05-01-shipped-x.md"
    assert captured[0].exists()


def test_cli_brag_add_prompts_for_title_when_omitted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "--date", "2026-05-01"],
            input="Shipped Y\n\n",  # title, then empty tags
        )

    assert result.exit_code == 0, result.output
    assert (ws / "brag" / "2026-05-01-shipped-y.md").exists()


def test_cli_brag_add_rejects_invalid_date(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app, ["brag", "add", "X", "--date", "not-a-date"]
    )
    assert result.exit_code == 1
    assert "invalid date" in result.output.lower()


def test_cli_brag_add_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["brag", "add", "X"])
    assert result.exit_code == 2


# --- CLI: career brag list ---


def test_cli_brag_list_empty_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["brag", "list"])
    assert result.exit_code == 0
    assert "no brag entries" in result.output.lower()


def test_cli_brag_list_shows_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    brag_core.create_entry(ws, title="Shipped X", entry_date=date(2026, 5, 1))
    brag_core.create_entry(ws, title="Cut Latency", entry_date=date(2026, 4, 1))

    result = runner.invoke(app, ["brag", "list"])
    assert result.exit_code == 0, result.output
    assert "shipped x" in result.output.lower()
    assert "cut latency" in result.output.lower()


def test_cli_brag_list_filters_by_tag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    folder = brag_core.brag_dir(ws)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "2026-05-01-a.md").write_text(
        "---\ndate: 2026-05-01\ntags: [backend]\n---\n", encoding="utf-8"
    )
    (folder / "2026-04-01-b.md").write_text(
        "---\ndate: 2026-04-01\ntags: [frontend]\n---\n", encoding="utf-8"
    )

    result = runner.invoke(app, ["brag", "list", "--tag", "backend"])
    assert result.exit_code == 0
    assert "2026-05-01-a" in result.output or " a" in result.output.lower()
    assert "2026-04-01-b" not in result.output


def test_cli_brag_list_respects_last(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    for i in range(5):
        brag_core.create_entry(
            ws, title=f"win {i}", entry_date=date(2026, i + 1, 1)
        )
    result = runner.invoke(app, ["brag", "list", "--last", "2"])
    assert result.exit_code == 0
    assert "showing 2 of 5" in result.output.lower()


# --- CLI: career brag show ---


def test_cli_brag_show_renders_markdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    path = brag_core.create_entry(
        ws, title="Shipped feature", entry_date=date(2026, 5, 1)
    )
    text = path.read_text(encoding="utf-8")
    path.write_text(
        text.replace("## What (X)\n\n\n", "## What (X)\n\nShipped a new feature.\n"),
        encoding="utf-8",
    )

    result = runner.invoke(app, ["brag", "show", "shipped"])
    assert result.exit_code == 0, result.output
    assert "Shipped a new feature" in result.output


def test_cli_brag_show_missing_entry_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["brag", "show", "nope"])
    assert result.exit_code == 1
    assert "no brag entry" in result.output.lower()


def test_cli_brag_show_disambiguates_multiple(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    brag_core.create_entry(ws, title="Win A", entry_date=date(2026, 5, 1))
    brag_core.create_entry(ws, title="Win B", entry_date=date(2026, 4, 1))

    result = runner.invoke(app, ["brag", "show", "win"], input="1\n")
    assert result.exit_code == 0
    assert "multiple brag entries" in result.output.lower()


# --- tags integration ---


def _write_brag_with_tags(
    workspace: Path, slug: str, *, tags: list[str], body: str = "X"
) -> None:
    """Write a brag entry with explicit frontmatter tags (test fixture)."""
    folder = brag_core.brag_dir(workspace)
    folder.mkdir(parents=True, exist_ok=True)
    date_str = slug[:10]
    tags_yaml = "[" + ", ".join(tags) + "]"
    contents = f"---\ndate: {date_str}\ntags: {tags_yaml}\n---\n\n{body}\n"
    (folder / f"{slug}.md").write_text(contents, encoding="utf-8")


def test_create_entry_writes_tags_to_frontmatter(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = brag_core.create_entry(
        ws,
        title="Shipped X",
        entry_date=date(2026, 5, 1),
        tags=("acme-internship", "performance"),
    )
    text = path.read_text(encoding="utf-8")
    assert "acme-internship" in text
    assert "performance" in text

    entry = brag_core.list_entries(ws)[0]
    assert entry.tags == ("acme-internship", "performance")


def test_create_entry_empty_tags_renders_as_empty_list(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = brag_core.create_entry(
        ws, title="Shipped X", entry_date=date(2026, 5, 1)
    )
    text = path.read_text(encoding="utf-8")
    assert "tags: []" in text


def test_cli_brag_add_resolves_numbered_tag_pick(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_brag_with_tags(ws, "2026-04-01-prior", tags=["acme-internship"])
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "Cut Latency", "--date", "2026-05-01"],
            input="1\n",  # pick existing tag #1
        )

    assert result.exit_code == 0, result.output
    new_entry = brag_core.load_entry(ws, "2026-05-01-cut-latency")
    assert new_entry is not None
    assert new_entry.tags == ("acme-internship",)


def test_cli_brag_add_accepts_mix_of_number_and_freeform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_brag_with_tags(ws, "2026-04-01-prior", tags=["acme-internship"])
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "Migration", "--date", "2026-05-01"],
            input="1, Postgres, performance\n",
        )

    assert result.exit_code == 0, result.output
    new_entry = brag_core.load_entry(ws, "2026-05-01-migration")
    assert new_entry is not None
    # New tags are normalized to lowercase.
    assert new_entry.tags == ("acme-internship", "postgres", "performance")


def test_cli_brag_add_no_existing_tags_still_prompts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fresh workspace: prompt has no numbered list but still accepts free-form."""
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "First Win", "--date", "2026-05-01"],
            input="acme, performance\n",
        )

    assert result.exit_code == 0, result.output
    entry = brag_core.load_entry(ws, "2026-05-01-first-win")
    assert entry is not None
    assert entry.tags == ("acme", "performance")


def test_cli_brag_add_dash_skips_tags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_brag_with_tags(ws, "2026-04-01-prior", tags=["acme-internship"])
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "Untagged", "--date", "2026-05-01"],
            input="-\n",
        )

    assert result.exit_code == 0, result.output
    entry = brag_core.load_entry(ws, "2026-05-01-untagged")
    assert entry is not None
    assert entry.tags == ()


def test_cli_brag_add_out_of_range_number_becomes_freeform(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A number that doesn't index any existing tag is treated as a new string."""
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_brag_with_tags(ws, "2026-04-01-prior", tags=["acme"])
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "Weird", "--date", "2026-05-01"],
            input="99\n",
        )

    assert result.exit_code == 0, result.output
    entry = brag_core.load_entry(ws, "2026-05-01-weird")
    assert entry is not None
    assert entry.tags == ("99",)


def test_cli_brag_add_lists_existing_tags_in_prompt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_brag_with_tags(ws, "2026-04-01-a", tags=["acme-internship", "performance"])
    _write_brag_with_tags(ws, "2026-03-01-b", tags=["acme-internship"])
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(brag_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(
            app,
            ["brag", "add", "Next", "--date", "2026-05-01"],
            input="\n",
        )

    assert result.exit_code == 0, result.output
    assert "Existing tags:" in result.output
    assert "acme-internship" in result.output
    assert "performance" in result.output
    # Two brags reference acme-internship → count appears.
    assert "2 brags" in result.output
