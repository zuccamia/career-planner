"""Tests for `career skills browse` (tree, search, --for/--vs)."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import taxonomy
from career_planner.core.workspace import create_workspace

runner = CliRunner()


# --- core/taxonomy.py: new loaders ---


def test_load_occupations_contains_known_titles() -> None:
    occs = taxonomy.load_occupations()
    assert len(occs) > 100
    labels = {o.preferred_label for o in occs}
    assert "software developer" in labels
    assert "data analyst" in labels


def test_find_occupation_matches_exact() -> None:
    matches = taxonomy.find_occupation_matches("software developer")
    assert matches, "expected at least one match"
    top, score = matches[0]
    assert top.preferred_label == "software developer"
    assert score == 1.0


def test_find_occupation_matches_via_alt_label() -> None:
    # "software engineer" is an ESCO alt label for "software developer".
    # Before alt-label scoring it ranked 9th; now it should be the top hit.
    matches = taxonomy.find_occupation_matches("software engineer")
    assert matches
    top, score = matches[0]
    assert top.preferred_label == "software developer"
    assert score == 1.0


def test_find_occupation_matches_preferred_wins_tie_against_alt() -> None:
    # "data scientist" is the preferred label of one occupation and an alt
    # label of another ("bioinformatics scientist"). Both score 1.0; the
    # preferred-label hit must sort first so _resolve_occupation auto-picks
    # the canonical match.
    matches = taxonomy.find_occupation_matches("data scientist")
    assert matches
    top, score = matches[0]
    assert top.preferred_label == "data scientist"
    assert score == 1.0


def test_find_occupation_by_uri_round_trip() -> None:
    occs = taxonomy.load_occupations()
    sample = occs[0]
    assert taxonomy.find_occupation_by_uri(sample.uri) == sample
    assert taxonomy.find_occupation_by_uri("not-a-uri") is None
    assert taxonomy.find_occupation_by_uri("") is None


def test_load_occupation_skills_returns_mapping() -> None:
    mapping = taxonomy.load_occupation_skills()
    assert len(mapping) > 100
    sample_skills = next(iter(mapping.values()))
    assert isinstance(sample_skills, tuple)
    assert all(uri.startswith("http://data.europa.eu/esco/skill/") for uri in sample_skills)


def test_occupation_skills_for_software_developer() -> None:
    occ = next(
        o
        for o in taxonomy.load_occupations()
        if o.preferred_label == "software developer"
    )
    skills = taxonomy.occupation_skills(occ.uri)
    assert len(skills) >= 20
    # Every returned skill record is a hydrated Skill object.
    assert all(isinstance(s, taxonomy.Skill) for s in skills)


def test_load_skill_hierarchy_round_trip() -> None:
    parents_of, children_of = taxonomy.load_skill_hierarchy()
    assert parents_of, "hierarchy should not be empty"
    assert children_of, "child index should not be empty"
    # Spot check: every child's listed parents should themselves appear as
    # children-of keys exactly when those parents have parents.
    child, parents = next(iter(parents_of.items()))
    for parent in parents:
        assert child in children_of[parent]


def test_hierarchy_roots_are_disjoint_from_children() -> None:
    roots = taxonomy.hierarchy_roots()
    parents_of, _children = taxonomy.load_skill_hierarchy()
    for uri in roots:
        assert uri not in parents_of


def test_search_skills_text_finds_via_description() -> None:
    # Token only in descriptions (not in any preferred label) — would fail with
    # a label-only search.
    results = taxonomy.search_skills_text("microservices")
    labels = [s.preferred_label for s, _ in results]
    assert results
    assert "microservices" not in {l.lower() for l in labels}


def test_search_skills_text_ranks_label_above_description() -> None:
    results = taxonomy.search_skills_text("Haskell")
    assert results
    top, _score = results[0]
    assert top.preferred_label == "Haskell"


# --- CLI: career skills browse ---


def _workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_browse_tree_no_flags_prints_hierarchy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["skills", "browse"])
    assert result.exit_code == 0, result.output
    assert "ESCO skill hierarchy" in result.output
    # A known root label that's present in the curated subset.
    assert "computer programming" in result.output


def test_browse_search_finds_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["skills", "browse", "--search", "Haskell"])
    assert result.exit_code == 0, result.output
    assert "Haskell" in result.output


def test_browse_search_with_no_matches_reports_yellow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app, ["skills", "browse", "--search", "zzz-no-such-skill-xyz"]
    )
    assert result.exit_code == 0, result.output
    assert "no esco skills matched" in result.output.lower()


def test_browse_for_occupation_lists_skills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app, ["skills", "browse", "--for", "software developer"]
    )
    assert result.exit_code == 0, result.output
    assert "Occupation: software developer" in result.output
    # Both ESCO skill_type buckets should appear when present.
    assert "knowledge" in result.output or "skill/competence" in result.output


def test_browse_for_unknown_occupation_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app, ["skills", "browse", "--for", "zzz-fake-occupation-xyz"]
    )
    assert result.exit_code == 1
    assert "no esco occupation matched" in result.output.lower()


def test_browse_compare_two_occupations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        [
            "skills",
            "browse",
            "--for",
            "software developer",
            "--vs",
            "mobile application developer",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "software developer" in result.output
    assert "mobile application developer" in result.output
    assert "Overlap" in result.output


def test_browse_vs_without_for_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app, ["skills", "browse", "--vs", "software developer"]
    )
    assert result.exit_code == 1
    assert "--vs requires --for" in result.output


def test_browse_search_with_for_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        ["skills", "browse", "--search", "x", "--for", "software developer"],
    )
    assert result.exit_code == 1
    assert "--search cannot be combined" in result.output


def test_browse_compare_same_occupation_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        [
            "skills",
            "browse",
            "--for",
            "software developer",
            "--vs",
            "software developer",
        ],
    )
    assert result.exit_code == 1
    assert "same occupation" in result.output.lower()
