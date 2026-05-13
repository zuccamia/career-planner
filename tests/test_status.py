"""Tests for the status engine and `career status` CLI."""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.core import criteria as criteria_core
from career_planner.core import opportunities as opp_core
from career_planner.core import profile as profile_core
from career_planner.core import skills as skills_core
from career_planner.core import status as status_core
from career_planner.core.workspace import create_workspace

runner = CliRunner()

TODAY = date(2026, 5, 13)


# --- helpers -----------------------------------------------------------------


def _make_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    return workspace


def _save_profile(workspace: Path, **fields) -> None:
    profile_core.save_profile(workspace, dict(fields))


def _save_inventory(workspace: Path, skills: list[dict]) -> None:
    skills_core.save_inventory(workspace, skills)


def _add_opportunity(
    workspace: Path,
    *,
    title: str,
    status: str = "active",
    created: date | None = None,
    deadline: date | None = None,
    required_skills: list | None = None,
    role: str | None = None,
    company: str | None = None,
    location: str | None = None,
    work_type: str | None = None,
) -> None:
    extra: dict = {"status": status}
    if deadline is not None:
        extra["deadline"] = deadline.isoformat()
    if required_skills is not None:
        extra["required_skills"] = required_skills
    if role is not None:
        extra["role"] = role
    if company is not None:
        extra["company"] = company
    if location is not None:
        extra["location"] = location
    if work_type is not None:
        extra["work_type"] = work_type
    opp_core.create_opportunity(
        workspace,
        title=title,
        extra=extra,
        created=created or TODAY,
    )


def _write_brag(workspace: Path, name: str, *, date_str: str | None) -> None:
    folder = workspace / "brag"
    folder.mkdir(exist_ok=True)
    if date_str is None:
        body = "## What I accomplished\n"
    else:
        body = f"---\ndate: {date_str}\n---\n\n## What I accomplished\n"
    (folder / name).write_text(body, encoding="utf-8")


# --- core/status.gather ------------------------------------------------------


def test_gather_empty_workspace(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    report = status_core.gather(workspace, today=TODAY)

    assert report.profile_filled_fields == 0
    assert report.profile_total_fields == len(status_core.PROFILE_REQUIRED_FIELDS)
    assert report.profile_missing == status_core.PROFILE_REQUIRED_FIELDS
    assert report.skills_count == 0
    assert report.brag_count == 0
    assert report.active_opportunities == ()
    assert report.upcoming_deadlines == ()
    assert report.stale_opportunities == ()
    assert report.no_recent_brag is True
    assert report.skills_stale is True


def test_profile_completeness_counts_filled_fields(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _save_profile(
        workspace,
        name="Alex",
        current_role="Engineer",
        current_company="Acme",
        target_role="Staff Engineer",
        target_timeline="2-3 years",
    )
    report = status_core.gather(workspace, today=TODAY)
    assert report.profile_filled_fields == 5
    assert report.profile_completeness == 100
    assert report.profile_missing == ()


def test_profile_partial_completeness_reports_missing_fields(
    tmp_path: Path,
) -> None:
    workspace = _make_workspace(tmp_path)
    _save_profile(
        workspace, name="Alex", current_role="Engineer", target_role=""
    )
    report = status_core.gather(workspace, today=TODAY)
    assert report.profile_filled_fields == 2
    assert "current_company" in report.profile_missing
    assert "target_role" in report.profile_missing
    assert report.profile_completeness == 40


def test_skills_freshness_uses_latest_added_date(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _save_inventory(
        workspace,
        [
            {"skill": "Python", "added": "2026-03-20", "rating": 4},
            {"skill": "Rust", "added": "2025-12-01", "rating": 3},
        ],
    )
    report = status_core.gather(workspace, today=TODAY)
    assert report.skills_count == 2
    assert report.skills_last_updated == date(2026, 3, 20)
    assert report.days_since_skills_update == (TODAY - date(2026, 3, 20)).days
    assert report.skills_stale is False


def test_skills_stale_when_over_six_months(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _save_inventory(
        workspace,
        [{"skill": "Python", "added": "2025-08-01", "rating": 4}],
    )
    report = status_core.gather(workspace, today=TODAY)
    assert report.skills_stale is True


def test_brag_freshness_from_frontmatter(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_brag(workspace, "2026-04-10-shipped-x.md", date_str="2026-04-10")
    _write_brag(workspace, "2026-01-05-old.md", date_str="2026-01-05")
    report = status_core.gather(workspace, today=TODAY)
    assert report.brag_count == 2
    assert report.last_brag_date == date(2026, 4, 10)
    assert report.no_recent_brag is False


def test_brag_freshness_falls_back_to_filename(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_brag(workspace, "2026-04-15-no-frontmatter.md", date_str=None)
    report = status_core.gather(workspace, today=TODAY)
    assert report.brag_count == 1
    assert report.last_brag_date == date(2026, 4, 15)


def test_brag_marked_stale_when_over_a_quarter(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_brag(workspace, "2025-12-01-old.md", date_str="2025-12-01")
    report = status_core.gather(workspace, today=TODAY)
    assert report.no_recent_brag is True


def test_active_opportunities_and_deadlines(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(
        workspace,
        title="Staff Engineer at Acme",
        status="active",
        created=TODAY - timedelta(days=5),
        deadline=TODAY + timedelta(days=15),
    )
    _add_opportunity(
        workspace,
        title="Backend Eng at Globex",
        status="active",
        created=TODAY - timedelta(days=2),
        deadline=TODAY + timedelta(days=60),  # too far for the 30-day horizon
    )
    _add_opportunity(
        workspace,
        title="Closed Role",
        status="closed",
        created=TODAY - timedelta(days=2),
    )
    report = status_core.gather(workspace, today=TODAY)
    assert len(report.active_opportunities) == 2
    assert len(report.upcoming_deadlines) == 1
    assert report.upcoming_deadlines[0].title == "Staff Engineer at Acme"
    assert report.upcoming_deadlines[0].days_until_deadline == 15


def test_stale_opportunities_flagged_when_created_long_ago(
    tmp_path: Path,
) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(
        workspace,
        title="Old Role",
        status="active",
        created=TODAY - timedelta(days=45),
    )
    _add_opportunity(
        workspace,
        title="Fresh Role",
        status="active",
        created=TODAY - timedelta(days=3),
    )
    report = status_core.gather(workspace, today=TODAY)
    assert len(report.stale_opportunities) == 1
    assert report.stale_opportunities[0].title == "Old Role"


def test_coverage_uses_inventory_vs_required_skills(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _save_inventory(
        workspace,
        [
            {"skill": "Python programming", "added": "2026-04-01", "rating": 4},
            {"skill": "AWS", "added": "2026-04-01", "rating": 3},
        ],
    )
    _add_opportunity(
        workspace,
        title="Senior Engineer",
        required_skills=["Python programming", "AWS", "Kubernetes", "Rust"],
    )
    report = status_core.gather(workspace, today=TODAY)
    summary = report.active_opportunities[0]
    assert summary.coverage is not None
    assert 0.0 < summary.coverage < 1.0
    assert summary.coverage == 0.5


def test_coverage_none_when_no_requirements(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(workspace, title="Role")
    report = status_core.gather(workspace, today=TODAY)
    assert report.active_opportunities[0].coverage is None


# --- criteria fit cache -----------------------------------------------------


_CRITERIA_WITH_DEALBREAKER = {
    "function": {"want": ["backend"], "dealbreakers": ["no coding"]},
    "compensation": {"base_minimum": 100000},
}


def _write_criteria(workspace: Path, data: dict) -> None:
    criteria_core.save_criteria(workspace, data)


def _run_criteria_check(workspace: Path, opp_slug: str) -> None:
    """Mimic `career criteria check` so we can observe the cache it writes."""
    opp = opp_core.load_opportunity(workspace, opp_slug)
    assert opp is not None
    criteria = criteria_core.load_criteria(workspace)
    result = criteria_core.check_against_opportunity(criteria, opp)
    criteria_core.save_check_to_opportunity(
        workspace, result, criteria, today=TODAY
    )


def test_criteria_hash_is_stable_for_equal_dicts() -> None:
    a = {"function": {"want": ["a", "b"]}, "compensation": {"base_minimum": 100}}
    b = {"compensation": {"base_minimum": 100}, "function": {"want": ["a", "b"]}}
    assert criteria_core.criteria_hash(a) == criteria_core.criteria_hash(b)


def test_criteria_hash_differs_when_content_changes() -> None:
    a = {"function": {"want": ["python"]}}
    b = {"function": {"want": ["python", "rust"]}}
    assert criteria_core.criteria_hash(a) != criteria_core.criteria_hash(b)


def test_save_check_to_opportunity_writes_cache_block(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_criteria(workspace, _CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(workspace, title="Role")
    slug = opp_core.list_opportunities(workspace)[0].slug
    _run_criteria_check(workspace, slug)

    opp = opp_core.load_opportunity(workspace, slug)
    cache = opp.frontmatter["criteria_check"]
    assert cache["checked_at"] == TODAY.isoformat()
    assert cache["criteria_hash"] == criteria_core.criteria_hash(
        _CRITERIA_WITH_DEALBREAKER
    )
    assert "alignment" in cache
    assert "dealbreaker_count" in cache
    assert "scored_dimensions" in cache
    assert cache["ai_augmented"] is False


def test_status_reads_cached_fit_without_recomputing(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_criteria(workspace, _CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(workspace, title="Role")
    slug = opp_core.list_opportunities(workspace)[0].slug
    _run_criteria_check(workspace, slug)

    report = status_core.gather(workspace, today=TODAY)
    fit = report.active_opportunities[0].fit
    assert fit is not None
    assert fit.stale is False
    assert fit.ai_augmented is False
    assert fit.checked_at == TODAY


def test_status_marks_fit_stale_when_criteria_change(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_criteria(workspace, _CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(workspace, title="Role")
    slug = opp_core.list_opportunities(workspace)[0].slug
    _run_criteria_check(workspace, slug)

    # Mutate criteria without rerunning the check.
    _write_criteria(
        workspace,
        {**_CRITERIA_WITH_DEALBREAKER, "growth": {"motivators": ["new"]}},
    )

    report = status_core.gather(workspace, today=TODAY)
    fit = report.active_opportunities[0].fit
    assert fit is not None
    assert fit.stale is True


def test_status_returns_no_fit_when_check_never_ran(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _write_criteria(workspace, _CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(workspace, title="Role")

    report = status_core.gather(workspace, today=TODAY)
    assert report.active_opportunities[0].fit is None


# --- new opportunity columns -----------------------------------------------


def test_open_status_includes_free_form_states(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(workspace, title="A", status="active")
    _add_opportunity(workspace, title="B", status="OA")
    _add_opportunity(workspace, title="C", status="first interview")
    _add_opportunity(workspace, title="D", status="rejected")
    _add_opportunity(workspace, title="E", status="closed")
    _add_opportunity(workspace, title="F", status="withdrawn")

    report = status_core.gather(workspace, today=TODAY)
    statuses = {s.status for s in report.active_opportunities}
    assert statuses == {"active", "OA", "first interview"}


def test_summary_carries_role_company_location_type_status(
    tmp_path: Path,
) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(
        workspace,
        title="Senior Engineer at Acme",
        role="Senior Software Engineer",
        company="Acme Corp",
        location="Redmond, Washington, United States",
        work_type="hybrid",
        status="OA",
    )
    report = status_core.gather(workspace, today=TODAY)
    summary = report.active_opportunities[0]
    assert summary.role == "Senior Software Engineer"
    assert summary.company == "Acme Corp"
    assert summary.location == "Redmond, Washington, United States"
    assert summary.location_short == "Redmond, Washington"
    assert summary.work_type == "hybrid"
    assert summary.status == "OA"


def test_shorten_location_handles_common_shapes() -> None:
    short = opp_core.shorten_location
    assert short("") == ""
    assert short("Remote") == "Remote"
    assert short("San Francisco, CA, USA") == "San Francisco, CA"
    assert short("Redmond, Washington, United States") == "Redmond, Washington"
    assert short("London") == "London"
    # Long output is truncated with an ellipsis (default cap 22 chars).
    out = short("Saint-Petersburg-on-the-Sea, Republicania")
    assert out.endswith("…")
    assert len(out) <= 22


def test_status_renders_new_columns(tmp_path: Path, monkeypatch) -> None:
    workspace = _make_workspace(tmp_path)
    _add_opportunity(
        workspace,
        title="Backend Eng",
        role="Senior Backend Engineer",
        company="Globex",
        location="San Francisco, CA, USA",
        work_type="remote",
        status="first interview",
        created=TODAY - timedelta(days=6),
    )
    monkeypatch.chdir(workspace)
    _pin_today(monkeypatch)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    out = result.output
    for header in ("Role", "Company", "Location", "Type", "Status"):
        assert header in out
    # Rich wraps long cells, so the role/location strings can split across
    # lines. Check for unambiguous tokens that survive wrapping.
    for token in ("Senior", "Backend", "Engineer", "Globex", "remote", "first"):
        assert token in out, f"missing token: {token!r}"
    assert "6d" in out


def test_status_renders_age_and_fit_columns(tmp_path: Path, monkeypatch) -> None:
    workspace = _make_workspace(tmp_path)
    _write_criteria(workspace, _CRITERIA_WITH_DEALBREAKER)
    _add_opportunity(
        workspace,
        title="Senior Engineer",
        status="active",
        created=TODAY - timedelta(days=4),
    )
    slug = opp_core.list_opportunities(workspace)[0].slug
    _run_criteria_check(workspace, slug)

    monkeypatch.chdir(workspace)
    _pin_today(monkeypatch)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Age" in result.output
    assert "Fit" in result.output
    assert "4d" in result.output


def test_orphan_resumes_detected(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    (workspace / "resumes" / "resume-v1.pdf").write_bytes(b"%PDF-1.4\n")
    (workspace / "resumes" / "resume-v2.pdf").write_bytes(b"%PDF-1.4\n")
    (workspace / "resumes" / "resume-v2.yml").write_text(
        "filename: resume-v2.pdf\n", encoding="utf-8"
    )
    report = status_core.gather(workspace, today=TODAY)
    assert len(report.orphan_resumes) == 1
    assert report.orphan_resumes[0].name == "resume-v1.pdf"


def test_orphan_files_detected_in_known_folders(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    (workspace / "opportunities" / "stray.txt").write_text("oops", encoding="utf-8")
    (workspace / "brag" / "notes.txt").write_text("oops", encoding="utf-8")
    report = status_core.gather(workspace, today=TODAY)
    orphan_names = {p.name for p in report.orphan_files}
    assert "stray.txt" in orphan_names
    assert "notes.txt" in orphan_names


def test_dotfiles_are_not_orphans(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    (workspace / "opportunities" / ".DS_Store").write_text("", encoding="utf-8")
    report = status_core.gather(workspace, today=TODAY)
    assert report.orphan_files == ()


def test_warnings_compose_correctly(tmp_path: Path) -> None:
    workspace = _make_workspace(tmp_path)
    _save_profile(workspace, name="Alex")  # most fields still missing
    _write_brag(workspace, "2025-09-01-old.md", date_str="2025-09-01")
    _save_inventory(
        workspace, [{"skill": "Python", "added": "2024-10-01", "rating": 4}]
    )
    _add_opportunity(
        workspace,
        title="Stale Role",
        status="active",
        created=TODAY - timedelta(days=40),
    )
    (workspace / "resumes" / "orphan.pdf").write_bytes(b"%PDF-1.4\n")

    report = status_core.gather(workspace, today=TODAY)
    joined = " | ".join(report.warnings)
    assert "Profile is missing" in joined
    assert "Skills inventory hasn't been updated" in joined
    assert "No brag entries in the last quarter" in joined
    assert "30+ days" in joined
    assert "missing a .yml sidecar" in joined


# --- CLI ---------------------------------------------------------------------


def test_status_outside_workspace_exits_two(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 2


def _pin_today(monkeypatch, today: date = TODAY) -> None:
    """Force ``status_core.gather`` to always use ``today``."""
    real_gather = status_core.gather
    monkeypatch.setattr(
        status_core,
        "gather",
        lambda ws, today=None: real_gather(ws, today=today),
    )


def test_status_renders_summary(tmp_path: Path, monkeypatch) -> None:
    workspace = _make_workspace(tmp_path)
    _save_profile(workspace, name="Alex", current_role="Engineer")
    _save_inventory(
        workspace, [{"skill": "Python", "added": "2026-04-01", "rating": 4}]
    )
    _add_opportunity(
        workspace,
        title="Senior Engineer",
        status="active",
        created=TODAY - timedelta(days=5),
        deadline=TODAY + timedelta(days=10),
        required_skills=["Python", "Rust"],
    )
    _write_brag(workspace, "2026-04-15-shipped.md", date_str="2026-04-15")
    monkeypatch.chdir(workspace)
    _pin_today(monkeypatch)

    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    out = result.output
    assert "Career status" in out
    assert "Profile completeness" in out
    assert "Skills inventory" in out
    assert "Senior Engineer" in out
    assert "Upcoming deadlines" in out
    assert "Coverage" in out


def test_status_shows_warnings_panel(tmp_path: Path, monkeypatch) -> None:
    workspace = _make_workspace(tmp_path)
    monkeypatch.chdir(workspace)
    _pin_today(monkeypatch)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Warnings" in result.output


def test_status_empty_workspace_renders_without_crashing(
    tmp_path: Path, monkeypatch
) -> None:
    workspace = _make_workspace(tmp_path)
    monkeypatch.chdir(workspace)
    _pin_today(monkeypatch)
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "Career status" in result.output