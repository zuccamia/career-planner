"""Tests for the status engine and `career status` CLI."""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import criteria as criteria_core
from career_planner.core import opportunity as opp_core
from career_planner.core import skills as skills_core
from career_planner.core import status as status_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})

TODAY = date(2026, 5, 13)

CRITERIA_WITH_DEALBREAKER = {
    "function": {"want": ["backend"], "dealbreakers": ["no coding"]},
    "compensation": {"base_minimum": 100000},
}


# --- fixtures & helpers ------------------------------------------------------


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    return workspace


@pytest.fixture()
def ws_cd(ws: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(ws)
    _pin_today(monkeypatch)
    return ws


def _pin_today(monkeypatch: pytest.MonkeyPatch, today: date = TODAY) -> None:
    real_gather = status_core.gather
    pinned = today
    monkeypatch.setattr(
        status_core, "gather",
        lambda ws, today=None: real_gather(ws, today=pinned),
    )


def _add_opportunity(
    workspace: Path, *,
    title: str, status: str = "active",
    created: date | None = None, deadline: date | None = None,
    required_skills: list | None = None,
    role: str | None = None, company: str | None = None,
    location: str | None = None, work_type: str | None = None,
) -> None:
    extra: dict[str, Any] = {"status": status}
    for key, val in (("deadline", deadline), ("required_skills", required_skills),
                     ("role", role), ("company", company),
                     ("location", location), ("work_type", work_type)):
        if val is not None:
            extra[key] = val.isoformat() if isinstance(val, date) else val
    opp_core.create_opportunity(workspace, title=title, extra=extra, created=created or TODAY)


def _write_brag(workspace: Path, name: str, *, date_str: str | None) -> None:
    folder = workspace / "brag"
    folder.mkdir(exist_ok=True)
    body = f"---\ndate: {date_str}\n---\n\n" if date_str else ""
    (folder / name).write_text(body + "## What I accomplished\n", encoding="utf-8")


def _run_criteria_check(workspace: Path, opp_slug: str) -> None:
    opp = opp_core.load_opportunity(workspace, opp_slug)
    assert opp is not None
    criteria = criteria_core.load_criteria(workspace)
    result = criteria_core.CriteriaCheck(
        opportunity_slug=opp.slug,
        opportunity_title=opp.title,
        dimensions=tuple(
            criteria_core.DimensionResult(
                name=dim, status=criteria_core.STATUS_UNKNOWN,
                positives=(), negatives=(), violations=(),
            )
            for dim in criteria_core.DIMENSIONS
        ),
    )
    criteria_core.save_check_to_opportunity(workspace, result, criteria, today=TODAY)


# --- core/status.gather: empty workspace ------------------------------------


def test_gather_empty_workspace(ws: Path) -> None:
    report = status_core.gather(ws, today=TODAY)
    assert report.skills_count == 0
    assert report.brag_count == 0
    assert report.active_opportunities == ()
    assert report.upcoming_deadlines == ()
    assert report.stale_opportunities == ()
    assert report.no_recent_brag is True
    assert report.skills_stale is True


# --- core/status.gather: skills freshness ------------------------------------


def test_skills_freshness_uses_latest_added_date(ws: Path) -> None:
    skills_core.save_inventory(ws, [
        {"skill": "Python", "added": "2026-03-20", "rating": 4},
        {"skill": "Rust", "added": "2025-12-01", "rating": 3},
    ])
    report = status_core.gather(ws, today=TODAY)
    assert report.skills_count == 2
    assert report.skills_last_updated == date(2026, 3, 20)
    assert report.days_since_skills_update == (TODAY - date(2026, 3, 20)).days
    assert report.skills_stale is False


def test_skills_stale_when_over_six_months(ws: Path) -> None:
    skills_core.save_inventory(ws, [{"skill": "Python", "added": "2025-08-01", "rating": 4}])
    assert status_core.gather(ws, today=TODAY).skills_stale is True


# --- core/status.gather: brag freshness -------------------------------------


def test_brag_freshness_from_frontmatter(ws: Path) -> None:
    _write_brag(ws, "2026-04-10-shipped-x.md", date_str="2026-04-10")
    _write_brag(ws, "2026-01-05-old.md", date_str="2026-01-05")
    report = status_core.gather(ws, today=TODAY)
    assert report.brag_count == 2
    assert report.last_brag_date == date(2026, 4, 10)
    assert report.no_recent_brag is False


def test_brag_freshness_falls_back_to_filename(ws: Path) -> None:
    _write_brag(ws, "2026-04-15-no-frontmatter.md", date_str=None)
    report = status_core.gather(ws, today=TODAY)
    assert report.brag_count == 1
    assert report.last_brag_date == date(2026, 4, 15)


def test_brag_marked_stale_when_over_a_quarter(ws: Path) -> None:
    _write_brag(ws, "2025-12-01-old.md", date_str="2025-12-01")
    assert status_core.gather(ws, today=TODAY).no_recent_brag is True


# --- core/status.gather: opportunities & deadlines ---------------------------


def test_active_opportunities_and_deadlines(ws: Path) -> None:
    _add_opportunity(ws, title="Staff Engineer at Acme",
                     created=TODAY - timedelta(days=5), deadline=TODAY + timedelta(days=15))
    _add_opportunity(ws, title="Backend Eng at Globex",
                     created=TODAY - timedelta(days=2), deadline=TODAY + timedelta(days=60))
    _add_opportunity(ws, title="Closed Role", status="closed",
                     created=TODAY - timedelta(days=2))

    report = status_core.gather(ws, today=TODAY)
    assert len(report.active_opportunities) == 2
    assert len(report.upcoming_deadlines) == 1
    assert report.upcoming_deadlines[0].title == "Staff Engineer at Acme"
    assert report.upcoming_deadlines[0].days_until_deadline == 15


def test_stale_opportunities_flagged_when_created_long_ago(ws: Path) -> None:
    _add_opportunity(ws, title="Old Role", created=TODAY - timedelta(days=45))
    _add_opportunity(ws, title="Fresh Role", created=TODAY - timedelta(days=3))

    report = status_core.gather(ws, today=TODAY)
    assert len(report.stale_opportunities) == 1
    assert report.stale_opportunities[0].title == "Old Role"


# --- core/status.gather: coverage --------------------------------------------


def test_coverage_uses_inventory_vs_required_skills(ws: Path) -> None:
    skills_core.save_inventory(ws, [
        {"skill": "Python programming", "added": "2026-04-01", "rating": 4},
        {"skill": "AWS", "added": "2026-04-01", "rating": 3},
    ])
    _add_opportunity(ws, title="Senior Engineer",
                     required_skills=["Python programming", "AWS", "Kubernetes", "Rust"])

    summary = status_core.gather(ws, today=TODAY).active_opportunities[0]
    assert summary.coverage == 0.5


def test_coverage_none_when_no_requirements(ws: Path) -> None:
    _add_opportunity(ws, title="Role")
    assert status_core.gather(ws, today=TODAY).active_opportunities[0].coverage is None


# --- core/status.gather: open status -----------------------------------------


def test_open_status_includes_free_form_states(ws: Path) -> None:
    for title, status in (("A", "active"), ("B", "OA"), ("C", "first interview"),
                          ("D", "rejected"), ("E", "closed"), ("F", "withdrawn")):
        _add_opportunity(ws, title=title, status=status)

    statuses = {s.status for s in status_core.gather(ws, today=TODAY).active_opportunities}
    assert statuses == {"active", "OA", "first interview"}


# --- core/status.gather: opportunity summary columns -------------------------


def test_summary_carries_role_company_location_type_status(ws: Path) -> None:
    _add_opportunity(ws, title="Senior Engineer at Acme",
                     role="Senior Software Engineer", company="Acme Corp",
                     location="Redmond, Washington, United States",
                     work_type="hybrid", status="OA")

    summary = status_core.gather(ws, today=TODAY).active_opportunities[0]
    assert summary.role == "Senior Software Engineer"
    assert summary.company == "Acme Corp"
    assert summary.location == "Redmond, Washington, United States"
    assert summary.location_short == "Redmond, Washington"
    assert summary.work_type == "hybrid"
    assert summary.status == "OA"


@pytest.mark.parametrize("input_loc,expected", [
    ("", ""),
    ("Remote", "Remote"),
    ("San Francisco, CA, USA", "San Francisco, CA"),
    ("Redmond, Washington, United States", "Redmond, Washington"),
    ("London", "London"),
])
def test_shorten_location(input_loc: str, expected: str) -> None:
    assert opp_core.shorten_location(input_loc) == expected


def test_shorten_location_truncates_long_output() -> None:
    out = opp_core.shorten_location("Saint-Petersburg-on-the-Sea, Republicania")
    assert out.endswith("\u2026")
    assert len(out) <= 22


# --- core/status.gather: orphans --------------------------------------------


def test_orphan_resumes_detected(ws: Path) -> None:
    (ws / "resumes" / "resume-v1.pdf").write_bytes(b"%PDF-1.4\n")
    (ws / "resumes" / "resume-v2.pdf").write_bytes(b"%PDF-1.4\n")
    (ws / "resumes" / "resume-v2.yml").write_text("filename: resume-v2.pdf\n", encoding="utf-8")

    report = status_core.gather(ws, today=TODAY)
    assert len(report.orphan_resumes) == 1
    assert report.orphan_resumes[0].name == "resume-v1.pdf"


def test_orphan_files_detected_in_known_folders(ws: Path) -> None:
    (ws / "opportunities" / "stray.txt").write_text("oops", encoding="utf-8")
    (ws / "brag" / "notes.txt").write_text("oops", encoding="utf-8")

    orphan_names = {p.name for p in status_core.gather(ws, today=TODAY).orphan_files}
    assert "stray.txt" in orphan_names
    assert "notes.txt" in orphan_names


def test_dotfiles_are_not_orphans(ws: Path) -> None:
    (ws / "opportunities" / ".DS_Store").write_text("", encoding="utf-8")
    assert status_core.gather(ws, today=TODAY).orphan_files == ()


# --- core/status.gather: warnings -------------------------------------------


def test_warnings_compose_correctly(ws: Path) -> None:
    _write_brag(ws, "2025-09-01-old.md", date_str="2025-09-01")
    skills_core.save_inventory(ws, [{"skill": "Python", "added": "2024-10-01", "rating": 4}])
    _add_opportunity(ws, title="Stale Role", created=TODAY - timedelta(days=40))
    (ws / "resumes" / "orphan.pdf").write_bytes(b"%PDF-1.4\n")

    joined = " | ".join(status_core.gather(ws, today=TODAY).warnings)
    for fragment in ("Skills inventory hasn't been updated",
                     "No brag entries in the last quarter",
                     "30+ days", "missing a .yml sidecar"):
        assert fragment in joined


# --- criteria fit cache ------------------------------------------------------


def test_criteria_hash_is_stable_for_equal_dicts() -> None:
    a = {"function": {"want": ["a", "b"]}, "compensation": {"base_minimum": 100}}
    b = {"compensation": {"base_minimum": 100}, "function": {"want": ["a", "b"]}}
    assert criteria_core.criteria_hash(a) == criteria_core.criteria_hash(b)


def test_criteria_hash_differs_when_content_changes() -> None:
    a = {"function": {"want": ["python"]}}
    b = {"function": {"want": ["python", "rust"]}}
    assert criteria_core.criteria_hash(a) != criteria_core.criteria_hash(b)


def test_save_check_to_opportunity_writes_cache_block(ws: Path) -> None:
    criteria_core.save_criteria(ws, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws, title="Role")
    slug = opp_core.list_opportunities(ws)[0].slug
    _run_criteria_check(ws, slug)

    cache = opp_core.load_opportunity(ws, slug).frontmatter["criteria_check"]
    assert cache["checked_at"] == TODAY.isoformat()
    assert cache["criteria_hash"] == criteria_core.criteria_hash(CRITERIA_WITH_DEALBREAKER)
    for key in ("alignment", "dealbreaker_count", "scored_dimensions"):
        assert key in cache
    assert "ai_augmented" not in cache


def test_status_reads_cached_fit_without_recomputing(ws: Path) -> None:
    criteria_core.save_criteria(ws, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws, title="Role")
    _run_criteria_check(ws, opp_core.list_opportunities(ws)[0].slug)

    fit = status_core.gather(ws, today=TODAY).active_opportunities[0].fit
    assert fit is not None
    assert fit.stale is False
    assert fit.checked_at == TODAY


def test_status_marks_fit_stale_when_criteria_change(ws: Path) -> None:
    criteria_core.save_criteria(ws, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws, title="Role")
    _run_criteria_check(ws, opp_core.list_opportunities(ws)[0].slug)

    criteria_core.save_criteria(
        ws, {**CRITERIA_WITH_DEALBREAKER, "growth": {"motivators": ["new"]}},
    )

    fit = status_core.gather(ws, today=TODAY).active_opportunities[0].fit
    assert fit is not None
    assert fit.stale is True


def test_status_returns_no_fit_when_check_never_ran(ws: Path) -> None:
    criteria_core.save_criteria(ws, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws, title="Role")
    assert status_core.gather(ws, today=TODAY).active_opportunities[0].fit is None


# --- CLI: career status ------------------------------------------------------


def test_status_outside_workspace_exits_two(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    assert runner.invoke(app, ["status"]).exit_code == 2


def test_status_empty_workspace_renders_without_crashing(ws_cd: Path) -> None:
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Career status" in result.output


def test_status_renders_summary(ws_cd: Path) -> None:
    skills_core.save_inventory(ws_cd, [{"skill": "Python", "added": "2026-04-01", "rating": 4}])
    _add_opportunity(ws_cd, title="Senior Engineer",
                     created=TODAY - timedelta(days=5), deadline=TODAY + timedelta(days=10),
                     required_skills=["Python", "Rust"])
    _write_brag(ws_cd, "2026-04-15-shipped.md", date_str="2026-04-15")

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    for expected in ("Career status", "Skills inventory", "Senior Engineer",
                     "Upcoming deadlines", "Coverage"):
        assert expected in result.output


def test_status_shows_warnings_panel(ws_cd: Path) -> None:
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Warnings" in result.output


def test_status_renders_new_columns(ws_cd: Path) -> None:
    _add_opportunity(ws_cd, title="Backend Eng",
                     role="Senior Backend Engineer", company="Globex",
                     location="San Francisco, CA, USA", work_type="remote",
                     status="first interview", created=TODAY - timedelta(days=6))

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    for header in ("Role", "Company", "Location", "Type", "Status"):
        assert header in result.output
    for token in ("Senior", "Backend", "Engineer", "Globex", "remote", "first", "6d"):
        assert token in result.output


def test_status_renders_age_and_fit_columns(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws_cd, title="Senior Engineer", created=TODAY - timedelta(days=4))
    _run_criteria_check(ws_cd, opp_core.list_opportunities(ws_cd)[0].slug)

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    for expected in ("Age", "Fit", "4d"):
        assert expected in result.output


# --- CLI: criteria summary line ----------------------------------------------


def test_status_criteria_line_says_unconfigured_when_criteria_empty(ws_cd: Path) -> None:
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Criteria: not yet configured" in result.output


def test_status_criteria_line_says_configured_when_no_opportunities(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, CRITERIA_WITH_DEALBREAKER)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Criteria: configured" in result.output


def test_status_criteria_line_reports_checked_count(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws_cd, title="A")
    _add_opportunity(ws_cd, title="B")
    _run_criteria_check(ws_cd, "a")

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Criteria check: 1/2 active checked" in result.output


def test_status_criteria_line_flags_stale_checks(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws_cd, title="A")
    _run_criteria_check(ws_cd, "a")

    criteria_core.save_criteria(
        ws_cd, {**CRITERIA_WITH_DEALBREAKER, "growth": {"motivators": ["new"]}},
    )

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Criteria check: 1/1 active checked, 1 stale" in result.output


def test_status_criteria_line_all_caught_up(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(ws_cd, title="A")
    _add_opportunity(ws_cd, title="B")
    _run_criteria_check(ws_cd, "a")
    _run_criteria_check(ws_cd, "b")

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Criteria check: 2/2 active checked" in result.output
    assert "stale" not in result.output.lower()