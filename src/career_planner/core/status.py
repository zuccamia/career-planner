"""Workspace status snapshot for ``career status``.

Pure data gathering: read skills inventory, opportunities, and brag
entries from a workspace; report freshness, coverage, and warnings.
No Rich/IO concerns live here — the command layer renders.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date
from pathlib import Path
from typing import Any

from career_planner.core import brag as brag_core
from career_planner.core import criteria as criteria_core
from career_planner.core import gap as gap_core
from career_planner.core import opportunity as opp_core
from career_planner.core import skills as skills_core
from career_planner.core.coercion import coerce_date
from career_planner.i18n import _

# Backward-compat alias. ``status.gather`` returned ``CriteriaFit`` on
# ``OpportunitySummary.fit`` before the criteria-check cache shape was
# unified — keep the name pointed at the canonical dataclass so external
# callers don't break.
CriteriaFit = criteria_core.CachedCheck

# Freshness thresholds, in days. Tuned to the cadence the man page promises:
# brag at least once a quarter, skills refreshed every six months,
# active opportunities should move within a month.
STALE_OPPORTUNITY_DAYS = 30
DEADLINE_HORIZON_DAYS = 30
STALE_SKILLS_DAYS = 183  # ~6 months
STALE_BRAG_DAYS = 90  # ~1 quarter


@dataclass(frozen=True)
class OpportunitySummary:
    """Lightweight projection of an opportunity used by the status dashboard."""

    slug: str
    title: str
    role: str
    status: str
    company: str
    location: str
    location_short: str
    work_type: str
    deadline: date | None
    days_until_deadline: int | None
    created: date | None
    days_since_created: int | None
    coverage: float | None  # ``None`` when the opp lists no required skills
    fit: criteria_core.CachedCheck | None  # ``None`` when criteria.yml is empty


@dataclass(frozen=True)
class StatusReport:
    """Full snapshot used by the renderer and any future MCP consumer."""

    skills_count: int
    skills_last_updated: date | None
    days_since_skills_update: int | None
    brag_count: int
    last_brag_date: date | None
    days_since_last_brag: int | None
    active_opportunities: tuple[OpportunitySummary, ...]
    upcoming_deadlines: tuple[OpportunitySummary, ...]
    stale_opportunities: tuple[OpportunitySummary, ...]
    orphan_resumes: tuple[Path, ...]
    orphan_files: tuple[Path, ...]
    criteria_is_empty: bool = False
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def opportunities_unchecked(self) -> int:
        """Number of active opportunities with no cached criteria check."""
        return sum(1 for s in self.active_opportunities if s.fit is None)

    @property
    def opportunities_stale_check(self) -> int:
        """Number of active opportunities whose cached check is stale."""
        return sum(
            1 for s in self.active_opportunities if s.fit is not None and s.fit.stale
        )

    @property
    def skills_stale(self) -> bool:
        if self.days_since_skills_update is None:
            return self.skills_count == 0
        return self.days_since_skills_update >= STALE_SKILLS_DAYS

    @property
    def no_recent_brag(self) -> bool:
        if self.last_brag_date is None:
            return True
        return (self.days_since_last_brag or 0) >= STALE_BRAG_DAYS


def gather(workspace: Path, *, today: date | None = None) -> StatusReport:
    """Read the workspace and return a populated :class:`StatusReport`."""
    today = today or date.today()
    inventory = skills_core.load_inventory(workspace)
    opportunities = opp_core.list_opportunities(workspace)
    criteria = criteria_core.load_criteria(workspace)
    current_criteria_hash = criteria_core.criteria_hash(criteria)

    skills_last, skills_days = _skills_freshness(inventory, today)
    brag_count, last_brag, brag_days = _brag_freshness(workspace, today)

    active = tuple(
        _summarize_opportunity(opp, inventory, current_criteria_hash, today)
        for opp in opportunities
        if opp_core.is_open_status(opp.status)
    )

    upcoming = tuple(
        s for s in active
        if s.days_until_deadline is not None
        and 0 <= s.days_until_deadline <= DEADLINE_HORIZON_DAYS
    )
    stale_opps = tuple(
        s for s in active
        if s.days_since_created is not None
        and s.days_since_created >= STALE_OPPORTUNITY_DAYS
    )

    orphan_resumes = tuple(_find_orphan_resumes(workspace))
    orphan_files = tuple(_find_orphan_files(workspace))

    report = StatusReport(
        skills_count=len(inventory),
        skills_last_updated=skills_last,
        days_since_skills_update=skills_days,
        brag_count=brag_count,
        last_brag_date=last_brag,
        days_since_last_brag=brag_days,
        active_opportunities=active,
        upcoming_deadlines=upcoming,
        stale_opportunities=stale_opps,
        orphan_resumes=orphan_resumes,
        orphan_files=orphan_files,
        criteria_is_empty=criteria_core.is_criteria_empty(criteria),
    )
    return _attach_warnings(report)


def _attach_warnings(report: StatusReport) -> StatusReport:
    warnings: list[str] = []
    if report.skills_count == 0:
        warnings.append(_("Skills inventory is empty — run `career skills add`."))
    elif report.skills_stale:
        warnings.append(
            _("Skills inventory hasn't been updated in over {n} months.").format(
                n=STALE_SKILLS_DAYS // 30
            )
        )
    if report.brag_count == 0:
        warnings.append(_("No brag entries yet — run `career brag add`."))
    elif report.no_recent_brag:
        warnings.append(
            _("No brag entries in the last quarter — capture a recent win.")
        )
    if report.stale_opportunities:
        warnings.append(
            _("{n} active opportunities with no update in {days}+ days.").format(
                n=len(report.stale_opportunities), days=STALE_OPPORTUNITY_DAYS
            )
        )
    if report.orphan_resumes:
        warnings.append(
            _("{n} resume PDFs missing a .yml sidecar.").format(
                n=len(report.orphan_resumes)
            )
        )
    if report.orphan_files:
        warnings.append(
            _("{n} orphaned files in workspace folders.").format(
                n=len(report.orphan_files)
            )
        )

    return replace(report, warnings=tuple(warnings))


def _skills_freshness(
    inventory: list[dict[str, Any]], today: date
) -> tuple[date | None, int | None]:
    latest: date | None = None
    for entry in inventory:
        value = entry.get("added")
        parsed = coerce_date(value)
        if parsed is None:
            continue
        if latest is None or parsed > latest:
            latest = parsed
    if latest is None:
        return None, None
    return latest, (today - latest).days


def _brag_freshness(
    workspace: Path, today: date
) -> tuple[int, date | None, int | None]:
    """Count dated brag entries and return the most recent date."""
    dated = [e for e in brag_core.list_entries(workspace) if e.date is not None]
    if not dated:
        return 0, None, None
    latest = max(e.date for e in dated)
    return len(dated), latest, (today - latest).days


def _summarize_opportunity(
    opp: opp_core.Opportunity,
    inventory: list[dict[str, Any]],
    current_criteria_hash: str,
    today: date,
) -> OpportunitySummary:
    deadline = coerce_date(opp.frontmatter.get("deadline"))
    created = coerce_date(opp.frontmatter.get("created"))
    days_until = (deadline - today).days if deadline else None
    days_since = (today - created).days if created else None
    work_type = str(opp.frontmatter.get("work_type") or "").strip()
    return OpportunitySummary(
        slug=opp.slug,
        title=opp.title,
        role=opp.role,
        status=opp.status,
        company=opp.company,
        location=opp.location,
        location_short=opp_core.shorten_location(opp.location),
        work_type=work_type,
        deadline=deadline,
        days_until_deadline=days_until,
        created=created,
        days_since_created=days_since,
        coverage=_coverage(opp, inventory),
        fit=criteria_core.read_cached_check(
            opp, current_criteria_hash=current_criteria_hash
        ),
    )


def _coverage(
    opp: opp_core.Opportunity, inventory: list[dict[str, Any]]
) -> float | None:
    raw = opp.frontmatter.get("required_skills")
    requirements = gap_core.parse_requirements(raw)
    if not requirements:
        return None
    analysis = gap_core.analyze(inventory, requirements)
    return analysis.coverage


def _find_orphan_resumes(workspace: Path) -> list[Path]:
    folder = workspace / "resumes"
    if not folder.exists():
        return []
    out: list[Path] = []
    for pdf in sorted(folder.glob("*.pdf")):
        sidecar = pdf.with_suffix(".yml")
        if not sidecar.exists():
            out.append(pdf)
    return out


# Folders we audit for stray files plus the extensions they should contain.
# resumes/ also legitimately holds .pdf and .yml; those are handled above.
_EXPECTED_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "opportunities": (".md",),
    "brag": (".md",),
    "assessments": (".md",),
    "conversations": (".md",),
    "resumes": (".pdf", ".yml"),
    "skills": (".yml",),
}


def _find_orphan_files(workspace: Path) -> list[Path]:
    out: list[Path] = []
    for subdir, extensions in _EXPECTED_EXTENSIONS.items():
        folder = workspace / subdir
        if not folder.exists():
            continue
        for path in sorted(folder.iterdir()):
            if not path.is_file():
                continue
            if path.name.startswith("."):
                continue
            if path.suffix.lower() in extensions:
                continue
            out.append(path)
    return out