"""Tests for the tag inventory module."""

from __future__ import annotations

from pathlib import Path

from career_planner.core import brag as brag_core
from career_planner.core import resume as resume_core
from career_planner.core import tags as tags_core
from career_planner.core.workspace import create_workspace


def _write_brag_with_tags(
    workspace: Path, slug: str, *, tags: list[str]
) -> None:
    folder = brag_core.brag_dir(workspace)
    folder.mkdir(parents=True, exist_ok=True)
    date_str = slug[:10]
    tags_yaml = "[" + ", ".join(tags) + "]"
    (folder / f"{slug}.md").write_text(
        f"---\ndate: {date_str}\ntags: {tags_yaml}\n---\n\n",
        encoding="utf-8",
    )


def test_collect_tags_empty_workspace(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert tags_core.collect_tags(ws) == []


def test_collect_tags_from_brag_only(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-a", tags=["acme", "perf"])
    _write_brag_with_tags(ws, "2026-04-01-b", tags=["acme"])

    usages = tags_core.collect_tags(ws)
    by_tag = {u.tag: u for u in usages}
    assert set(by_tag) == {"acme", "perf"}
    assert by_tag["acme"].brag_count == 2
    assert by_tag["acme"].experience_count == 0
    assert by_tag["perf"].brag_count == 1


def test_collect_tags_from_resume_only(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume_core.save_resume(
        ws,
        {
            "experience": [
                {"role": "Engineer", "tags": ["acme-internship", "backend"]},
                {"role": "Intern", "tags": ["acme-internship"]},
            ]
        },
    )
    usages = tags_core.collect_tags(ws)
    by_tag = {u.tag: u for u in usages}
    assert set(by_tag) == {"acme-internship", "backend"}
    assert by_tag["acme-internship"].experience_count == 2
    assert by_tag["acme-internship"].brag_count == 0
    assert by_tag["backend"].experience_count == 1


def test_collect_tags_merges_brag_and_resume(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["acme"])
    resume_core.save_resume(
        ws, {"experience": [{"role": "Engineer", "tags": ["acme", "thesis"]}]}
    )

    usages = tags_core.collect_tags(ws)
    by_tag = {u.tag: u for u in usages}
    assert by_tag["acme"].brag_count == 1
    assert by_tag["acme"].experience_count == 1
    assert by_tag["acme"].total == 2
    assert by_tag["thesis"].brag_count == 0
    assert by_tag["thesis"].experience_count == 1


def test_collect_tags_normalizes_case(tmp_path: Path) -> None:
    """'Acme' and 'acme' collapse to a single tag."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["Acme"])
    resume_core.save_resume(
        ws, {"experience": [{"role": "Engineer", "tags": ["acme"]}]}
    )

    usages = tags_core.collect_tags(ws)
    assert len(usages) == 1
    assert usages[0].tag == "acme"
    assert usages[0].brag_count == 1
    assert usages[0].experience_count == 1


def test_collect_tags_sorts_by_total_usage_desc(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-a", tags=["popular"])
    _write_brag_with_tags(ws, "2026-04-01-b", tags=["popular"])
    _write_brag_with_tags(ws, "2026-03-01-c", tags=["popular"])
    _write_brag_with_tags(ws, "2026-02-01-d", tags=["rare"])
    resume_core.save_resume(
        ws, {"experience": [{"role": "X", "tags": ["mid", "mid-other"]}]}
    )
    _write_brag_with_tags(ws, "2026-01-01-e", tags=["mid"])

    usages = tags_core.collect_tags(ws)
    tags_in_order = [u.tag for u in usages]
    # popular (3) > mid (2) > mid-other (1) = rare (1) — alphabetical tiebreak.
    assert tags_in_order == ["popular", "mid", "mid-other", "rare"]


def test_collect_tags_ignores_whitespace_and_empty(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["valid", '""', "   "])
    usages = tags_core.collect_tags(ws)
    assert [u.tag for u in usages] == ["valid"]


def test_normalize_trims_and_lowercases() -> None:
    assert tags_core.normalize("  AcMe  ") == "acme"
    assert tags_core.normalize("") == ""
    assert tags_core.normalize(None) == ""
    assert tags_core.normalize(42) == ""
