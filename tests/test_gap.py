"""Tests for the gap-analysis core and the `career gap` CLI."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import gap as gap_core
from career_planner.core import opportunities as opp_core
from career_planner.core import skills as skills_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})


# --- core/gap.py: parse_requirements ---


def test_parse_requirements_skips_non_list() -> None:
    assert gap_core.parse_requirements(None) == []
    assert gap_core.parse_requirements("python") == []
    assert gap_core.parse_requirements({}) == []


def test_parse_requirements_string_kept_as_free_text() -> None:
    reqs = gap_core.parse_requirements(["zzz-totally-made-up-skill-12345"])
    assert len(reqs) == 1
    assert reqs[0].label == "zzz-totally-made-up-skill-12345"
    assert reqs[0].esco_code == ""
    assert reqs[0].min_rating is None


def test_parse_requirements_uri_string_resolves_label() -> None:
    # An unknown URI should still be kept as the ESCO code; label falls
    # back to the raw URI when no skill record exists for it.
    uri = "http://data.europa.eu/esco/skill/not-a-real-skill"
    reqs = gap_core.parse_requirements([uri])
    assert len(reqs) == 1
    assert reqs[0].esco_code == uri


def test_parse_requirements_mapping_with_min_rating() -> None:
    reqs = gap_core.parse_requirements(
        [{"skill": "totally-fake-skill-xyz", "min_rating": 4}]
    )
    assert len(reqs) == 1
    assert reqs[0].label == "totally-fake-skill-xyz"
    assert reqs[0].min_rating == 4


def test_parse_requirements_mapping_clamps_bad_rating() -> None:
    reqs = gap_core.parse_requirements(
        [
            {"skill": "fake-a", "min_rating": 99},
            {"skill": "fake-b", "min_rating": "high"},
            {"skill": "fake-c", "min_rating": 0},
        ]
    )
    assert all(r.min_rating is None for r in reqs)


def test_parse_requirements_drops_empty_entries() -> None:
    reqs = gap_core.parse_requirements(["", "  ", {}, {"skill": ""}, "ok-skill"])
    assert [r.label for r in reqs] == ["ok-skill"]


# --- core/gap.py: analyze ---


def _req(
    label: str, *, esco_code: str = "", min_rating: int | None = None
) -> gap_core.Requirement:
    return gap_core.Requirement(
        label=label, esco_code=esco_code, min_rating=min_rating
    )


def _entry(
    *,
    skill: str,
    rating: int,
    example: str = "demo",
    esco_code: str | None = None,
) -> dict:
    entry: dict = {"skill": skill, "rating": rating, "example": example}
    if esco_code:
        entry["esco_code"] = esco_code
    return entry


def test_analyze_matches_by_esco_code() -> None:
    inventory = [
        _entry(
            skill="Python programming",
            rating=4,
            esco_code="http://data.europa.eu/esco/skill/python",
        )
    ]
    reqs = [
        _req(
            "Python programming",
            esco_code="http://data.europa.eu/esco/skill/python",
        )
    ]
    analysis = gap_core.analyze(inventory, reqs)
    assert len(analysis.matched) == 1
    assert analysis.matched[0].rating == 4
    assert analysis.coverage == 1.0


def test_analyze_matches_by_exact_label_case_insensitive() -> None:
    inventory = [_entry(skill="Project management", rating=3)]
    analysis = gap_core.analyze(inventory, [_req("project management")])
    assert len(analysis.matched) == 1
    assert analysis.matched[0].example == "demo"


def test_analyze_partial_when_below_required_rating() -> None:
    inventory = [_entry(skill="Python programming", rating=2)]
    analysis = gap_core.analyze(
        inventory, [_req("Python programming", min_rating=4)]
    )
    assert len(analysis.partial) == 1
    assert analysis.partial[0].rating == 2
    assert analysis.partial[0].requirement.min_rating == 4
    assert analysis.coverage == 0.0


def test_analyze_matched_when_meets_or_exceeds_threshold() -> None:
    inventory = [_entry(skill="Python programming", rating=5)]
    analysis = gap_core.analyze(
        inventory, [_req("Python programming", min_rating=4)]
    )
    assert len(analysis.matched) == 1
    assert not analysis.partial


def test_analyze_partial_when_rating_missing_but_threshold_set() -> None:
    # An inventory entry that omits rating but matches a thresholded
    # requirement still counts as partial — we don't know the level.
    inventory = [{"skill": "Python programming", "example": "x"}]
    analysis = gap_core.analyze(
        inventory, [_req("Python programming", min_rating=3)]
    )
    assert len(analysis.partial) == 1


def test_analyze_missing_when_not_in_inventory() -> None:
    inventory = [_entry(skill="Python programming", rating=4)]
    analysis = gap_core.analyze(inventory, [_req("Rust programming")])
    assert [m.requirement.label for m in analysis.missing] == ["Rust programming"]
    assert not analysis.matched
    assert analysis.coverage == 0.0


def test_analyze_mixed_buckets_in_order() -> None:
    inventory = [
        _entry(skill="Python programming", rating=4),
        _entry(skill="Project management", rating=2),
    ]
    reqs = [
        _req("Python programming"),
        _req("Project management", min_rating=4),
        _req("Rust programming"),
    ]
    analysis = gap_core.analyze(inventory, reqs)
    assert len(analysis.matched) == 1
    assert len(analysis.partial) == 1
    assert len(analysis.missing) == 1
    # Ordering of the .matches tuple mirrors requirement order.
    statuses = [m.status for m in analysis.matches]
    assert statuses == [
        gap_core.STATUS_MATCHED,
        gap_core.STATUS_PARTIAL,
        gap_core.STATUS_MISSING,
    ]


def test_analyze_matches_inventory_recorded_under_alt_label() -> None:
    """Inventory uses an ESCO alt-label; requirement is the canonical name.

    A user who recorded "Python" (an alt-label) should still match a
    requirement promoted to ESCO's canonical "Python (computer
    programming)" label.
    """
    from career_planner.core import taxonomy

    skill_with_alts = next(
        (s for s in taxonomy.load_skills() if s.alt_labels), None
    )
    if skill_with_alts is None:
        pytest.skip("No ESCO skill with alt labels in bundled taxonomy")

    inv = [
        {"skill": skill_with_alts.alt_labels[0], "rating": 4, "example": "x"}
    ]
    reqs = [
        gap_core.Requirement(
            label=skill_with_alts.preferred_label,
            esco_code=skill_with_alts.uri,
        )
    ]
    analysis = gap_core.analyze(inv, reqs)
    assert len(analysis.matched) == 1
    assert analysis.matched[0].rating == 4


def test_analyze_esco_code_wins_over_label() -> None:
    # Same ESCO URI, different label in the inventory — should still match.
    uri = "http://data.europa.eu/esco/skill/python"
    inventory = [
        _entry(skill="Python (the language)", rating=3, esco_code=uri)
    ]
    reqs = [_req("Python programming", esco_code=uri)]
    analysis = gap_core.analyze(inventory, reqs)
    assert len(analysis.matched) == 1


def test_analyze_empty_inventory_all_missing() -> None:
    analysis = gap_core.analyze([], [_req("Python"), _req("Go")])
    assert len(analysis.missing) == 2
    assert analysis.coverage == 0.0


def test_analyze_no_requirements_is_zero_coverage() -> None:
    analysis = gap_core.analyze([_entry(skill="Python", rating=4)], [])
    assert analysis.coverage == 0.0
    assert analysis.matches == ()


# --- core/gap.py: description scanning ---


def test_extract_description_section_finds_text() -> None:
    body = (
        "\n## Description\n\n"
        "Build great things with Python.\n\n"
        "## Pros\n\nNice team.\n"
    )
    out = gap_core.extract_description_section(body)
    assert "Build great things with Python." in out
    assert "Nice team" not in out


def test_extract_description_section_returns_empty_when_missing() -> None:
    assert gap_core.extract_description_section("") == ""
    assert gap_core.extract_description_section("## Pros\n\nx\n") == ""


def test_find_inventory_skills_in_text_matches_own_label() -> None:
    inventory = [_entry(skill="totally-fake-skill-x", rating=4)]
    text = "We use totally-fake-skill-x daily in our team."
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert len(hits) == 1
    assert hits[0].entry is inventory[0]
    assert "totally-fake-skill-x" in hits[0].context


def test_find_inventory_skills_in_text_matches_esco_alt_label() -> None:
    """An ESCO-coded inventory entry matches any of its alt-labels in prose."""
    from career_planner.core import taxonomy

    target = next(
        (
            s
            for s in taxonomy.load_skills()
            if s.alt_labels
            and any(
                len(a) >= 4 and " " not in a and a.isalpha()
                for a in s.alt_labels
            )
        ),
        None,
    )
    if target is None:
        pytest.skip("No ESCO skill with single-word alt labels available")

    alt = next(
        a for a in target.alt_labels
        if len(a) >= 4 and " " not in a and a.isalpha()
    )
    inventory = [
        _entry(
            skill=target.preferred_label,
            rating=3,
            esco_code=target.uri,
        )
    ]
    text = f"We work with {alt} in production."
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert len(hits) == 1
    assert alt.lower() in hits[0].context.lower()


def test_find_inventory_skills_in_text_word_boundary() -> None:
    """An inventory label embedded in a longer word should NOT match alone."""
    inventory = [_entry(skill="zskill", rating=4)]
    # 'zskill' embedded inside 'zskillery' must not match.
    text = "Our zskillery is famous but unrelated."
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert hits == []


def test_find_inventory_skills_in_text_omits_unmentioned() -> None:
    inventory = [
        _entry(skill="totally-fake-x", rating=4),
        _entry(skill="totally-fake-y", rating=3),
    ]
    text = "We only use totally-fake-x here."
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert [h.entry.get("skill") for h in hits] == ["totally-fake-x"]


def test_find_inventory_skills_in_text_handles_empty_inputs() -> None:
    assert gap_core.find_inventory_skills_in_text([], "anything") == []
    assert (
        gap_core.find_inventory_skills_in_text(
            [_entry(skill="x", rating=4)], ""
        )
        == []
    )


def test_find_inventory_skills_context_carries_surrounding_prose() -> None:
    inventory = [_entry(skill="totally-fake-x", rating=4)]
    text = "Candidates write production code in totally-fake-x for our data team."
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert len(hits) == 1
    ctx = hits[0].context
    assert "production code" in ctx
    assert "data team" in ctx


def test_find_inventory_skills_context_truncates_with_ellipsis() -> None:
    inventory = [_entry(skill="totally-fake-x", rating=4)]
    padding = ("filler " * 40).strip()
    text = f"{padding} totally-fake-x {padding}"
    hits = gap_core.find_inventory_skills_in_text(inventory, text)
    assert hits[0].context.startswith("…")
    assert hits[0].context.endswith("…")


# --- CLI: career gap ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def _write_opportunity(
    workspace: Path, slug: str, *, required_skills: list
) -> Path:
    path = opp_core.create_opportunity(workspace, title=slug)
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["required_skills"] = required_skills
    path.write_text(
        opp_core.serialize_markdown(front, body), encoding="utf-8"
    )
    return path


def _seed_inventory(workspace: Path, entries: list[dict]) -> None:
    skills_core.save_inventory(workspace, entries)


def test_cli_gap_renders_matched_and_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_opportunity(
        ws,
        "engineer-at-acme",
        required_skills=["totally-fake-skill-a", "totally-fake-skill-b"],
    )
    _seed_inventory(
        ws,
        [
            _entry(
                skill="totally-fake-skill-a",
                rating=4,
                example="Used at last job",
            )
        ],
    )

    result = runner.invoke(app, ["gap", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Matched" in result.output
    assert "Missing" in result.output
    assert "totally-fake-skill-a" in result.output
    assert "totally-fake-skill-b" in result.output
    assert "Used at last job" in result.output
    assert "50%" in result.output  # 1 of 2 matched


def test_cli_gap_renders_partial_when_under_threshold(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_opportunity(
        ws,
        "engineer-at-acme",
        required_skills=[{"skill": "totally-fake-skill-a", "min_rating": 4}],
    )
    _seed_inventory(
        ws, [_entry(skill="totally-fake-skill-a", rating=2)]
    )

    result = runner.invoke(app, ["gap", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Partial" in result.output
    assert "totally-fake-skill-a" in result.output
    assert "0%" in result.output


def test_cli_gap_fallback_shows_inventory_hits_in_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No required_skills: surface inventory skills mentioned in description
    and warn that missing skills cannot be reliably extracted."""
    ws = _init_workspace(tmp_path, monkeypatch)
    path = opp_core.create_opportunity(ws, title="prose-only-role")
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    body = body.replace(
        "## Description\n",
        "## Description\n\nWe work with totally-fake-x daily.\n",
        1,
    )
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")
    _seed_inventory(
        ws,
        [
            _entry(skill="totally-fake-x", rating=4, example="prior role"),
            _entry(skill="totally-fake-y", rating=3, example="other role"),
        ],
    )

    result = runner.invoke(app, ["gap", "prose-only-role"])
    assert result.exit_code == 0, result.output
    # The mentioned skill is shown; the unmentioned one is not.
    assert "totally-fake-x" in result.output
    assert "totally-fake-y" not in result.output
    # Warning panel directs the user to `opportunity parse` for missing skills.
    assert "missing skills" in result.output.lower()
    assert "opportunity parse" in result.output


def test_cli_gap_fallback_when_no_inventory_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    path = opp_core.create_opportunity(ws, title="prose-only-role")
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    body = body.replace(
        "## Description\n",
        "## Description\n\nSome generic prose unrelated to my skills.\n",
        1,
    )
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")
    _seed_inventory(ws, [_entry(skill="totally-fake-x", rating=4)])

    result = runner.invoke(app, ["gap", "prose-only-role"])
    assert result.exit_code == 0, result.output
    assert "none of your inventory" in result.output.lower()
    assert "opportunity parse" in result.output


def test_cli_gap_fallback_when_no_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No required_skills and no Description body: still exit 0 with a warning."""
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_opportunity(ws, "engineer-at-acme", required_skills=[])
    # Strip the Description heading out so the body has nothing to scan.
    path = ws / "opportunities" / "engineer-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    body = body.replace("## Description\n", "")
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")

    result = runner.invoke(app, ["gap", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "no description" in result.output.lower()
    assert "opportunity parse" in result.output


def test_cli_gap_missing_opportunity_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["gap", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_gap_outside_workspace_exits_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["gap", "anything"])
    assert result.exit_code == 2


def test_cli_gap_disambiguates_multiple_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_opportunity(
        ws, "Senior Engineer at Acme", required_skills=["fake-skill-a"]
    )
    _write_opportunity(
        ws, "Senior Engineer at Globex", required_skills=["fake-skill-b"]
    )

    result = runner.invoke(app, ["gap", "engineer"], input="1\n")
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


def test_cli_gap_suggest_prints_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_opportunity(
        ws, "engineer-at-acme", required_skills=["fake-skill-a"]
    )

    result = runner.invoke(app, ["gap", "engineer-at-acme", "--suggest"])
    assert result.exit_code == 0, result.output
    assert "--suggest" in result.output


def test_cli_gap_matches_by_esco_uri(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    uri = "http://data.europa.eu/esco/skill/python-fake"
    _write_opportunity(ws, "py-role", required_skills=[uri])
    _seed_inventory(
        ws,
        [
            _entry(
                skill="Python (with a custom label)",
                rating=4,
                esco_code=uri,
            )
        ],
    )

    result = runner.invoke(app, ["gap", "py-role"])
    assert result.exit_code == 0, result.output
    assert "Matched" in result.output
    assert "Missing" not in result.output
