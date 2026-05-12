"""Tests for the ESCO taxonomy loader and fuzzy matcher."""

from __future__ import annotations

from career_planner.core import taxonomy


def test_load_skills_returns_bundled_catalogue() -> None:
    skills = taxonomy.load_skills()
    assert len(skills) > 500
    labels = {s.preferred_label for s in skills}
    assert "Haskell" in labels
    assert "Python (computer programming)" in labels


def test_find_skill_by_uri_round_trip() -> None:
    skills = taxonomy.load_skills()
    sample = skills[0]
    assert taxonomy.find_skill_by_uri(sample.uri) == sample
    assert taxonomy.find_skill_by_uri("not-a-real-uri") is None
    assert taxonomy.find_skill_by_uri("") is None


def test_find_skill_matches_exact_case_insensitive() -> None:
    matches = taxonomy.find_skill_matches("haskell")
    assert matches, "expected at least one match for 'haskell'"
    top, score = matches[0]
    assert top.preferred_label == "Haskell"
    assert score == 1.0


def test_find_skill_matches_substring_query() -> None:
    matches = taxonomy.find_skill_matches("Python")
    labels = [s.preferred_label for s, _ in matches]
    assert "Python (computer programming)" in labels


def test_find_skill_matches_empty_query_returns_empty() -> None:
    assert taxonomy.find_skill_matches("") == []
    assert taxonomy.find_skill_matches("   ") == []


def test_find_skill_matches_no_results_below_threshold() -> None:
    matches = taxonomy.find_skill_matches("zzzqqqxxxx-nonsense-string")
    assert matches == []


def test_find_skill_matches_respects_limit() -> None:
    matches = taxonomy.find_skill_matches("a", limit=3, threshold=0.0)
    assert len(matches) <= 3
