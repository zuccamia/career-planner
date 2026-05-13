"""Workspace status snapshot for ``career status``.

Pure data gathering: read profile, skills inventory, opportunities, resumes,
and brag entries from a workspace; report freshness, coverage, and
warnings. No Rich/IO concerns live here — the command layer renders.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from career_planner.core import criteria as criteria_core
from career_planner.core import gap as gap_core
from career_planner.core import opportunities as opp_core
from career_planner.core import profile as profile_core
from career_planner.core import skills as skills_core
from career_planner.i18n import _

# Required profile fields used to compute completeness. Order matters — the
# "missing" report preserves it so users see the same prompt order they see
# in `career profile edit`.
PROFILE_REQUIRED_FIELDS: tuple[str, ...] = (
    "name",
    "current_role",
    "current_company",
    "target_role",
    "target_timeline",
)

# Freshness thresholds, in days. Tuned to the cadence the man page promises:
# brag at least once a quarter, skills refreshed every six months,
# active opportunities should move within a month.
STALE_OPPORTUNITY_DAYS = 30
DEADLINE_HORIZON_DAYS = 30
STALE_SKILLS_DAYS = 183  # ~6 months
STALE_BRAG_DAYS = 90  # ~1 quarter


@dataclass(frozen=True)
class CriteriaFit:
    """Cached criteria-check summary read from an opportunity's frontmatter.

    Written by ``career criteria check``; ``career status`` reads it back
    so the dashboard does not need to rerun the LLM check on every
    invocation. ``stale`` flips True when ``criteria.yml`` has changed
    since the cached check was written.
    """

    alignment: int  # percent 0–100
    dealbreaker_count: int
    scored_dimensions: int
    checked_at: date | None
    stale: bool

    @property
    def has_violations(self) -> bool:
        return self.dealbreaker_count > 0


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
    fit: CriteriaFit | None  # ``None`` when criteria.yml is empty


@dataclass(frozen=True)
class StatusReport:
    """Full snapshot used by the renderer and any future MCP consumer."""

    profile_filled_fields: int
    profile_total_fields: int
    profile_missing: tuple[str, ...]
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
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @property
    def profile_completeness(self) -> int:
        """Percent of required profile fields filled, 0–100."""
        if not self.profile_total_fields:
            return 0
        return round(100 * self.profile_filled_fields / self.profile_total_fields)

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
    profile = profile_core.load_profile(workspace)
    inventory = skills_core.load_inventory(workspace)
    opportunities = opp_core.list_opportunities(workspace)
    criteria = criteria_core.load_criteria(workspace)
    current_criteria_hash = criteria_core.criteria_hash(criteria)

    filled, missing = _profile_completeness(profile)
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
        profile_filled_fields=filled,
        profile_total_fields=len(PROFILE_REQUIRED_FIELDS),
        profile_missing=tuple(missing),
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
    )
    return _attach_warnings(report)


def _attach_warnings(report: StatusReport) -> StatusReport:
    warnings: list[str] = []
    if report.profile_missing:
        warnings.append(
            _("Profile is missing: {fields}").format(
                fields=", ".join(report.profile_missing)
            )
        )
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

    return StatusReport(
        profile_filled_fields=report.profile_filled_fields,
        profile_total_fields=report.profile_total_fields,
        profile_missing=report.profile_missing,
        skills_count=report.skills_count,
        skills_last_updated=report.skills_last_updated,
        days_since_skills_update=report.days_since_skills_update,
        brag_count=report.brag_count,
        last_brag_date=report.last_brag_date,
        days_since_last_brag=report.days_since_last_brag,
        active_opportunities=report.active_opportunities,
        upcoming_deadlines=report.upcoming_deadlines,
        stale_opportunities=report.stale_opportunities,
        orphan_resumes=report.orphan_resumes,
        orphan_files=report.orphan_files,
        warnings=tuple(warnings),
    )


def _profile_completeness(
    profile: dict[str, Any]
) -> tuple[int, list[str]]:
    """Return ``(filled_count, missing_field_names)`` over the required set."""
    filled = 0
    missing: list[str] = []
    for field_name in PROFILE_REQUIRED_FIELDS:
        if _has_value(profile.get(field_name)):
            filled += 1
        else:
            missing.append(field_name)
    return filled, missing


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return True


def _skills_freshness(
    inventory: list[dict[str, Any]], today: date
) -> tuple[date | None, int | None]:
    latest: date | None = None
    for entry in inventory:
        value = entry.get("added")
        parsed = _coerce_date(value)
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
    """Count brag entries and return the most recent date."""
    folder = workspace / "brag"
    if not folder.exists():
        return 0, None, None
    entries: list[date] = []
    for path in sorted(folder.glob("*.md")):
        parsed = _read_brag_date(path)
        if parsed is not None:
            entries.append(parsed)
    if not entries:
        return 0, None, None
    latest = max(entries)
    return len(entries), latest, (today - latest).days


_FRONT_DELIM = "---"
_FILENAME_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def _read_brag_date(path: Path) -> date | None:
    """Extract a date from a brag entry. Prefers frontmatter, then filename."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    parsed = _frontmatter_date(text)
    if parsed is not None:
        return parsed
    return _filename_date(path)


def _frontmatter_date(text: str) -> date | None:
    if not text.startswith(_FRONT_DELIM):
        return None
    rest = text[len(_FRONT_DELIM):]
    if rest.startswith("\n"):
        rest = rest[1:]
    end = rest.find(f"\n{_FRONT_DELIM}")
    if end == -1:
        return None
    block = rest[:end]
    try:
        data = yaml.safe_load(block) or {}
    except yaml.YAMLError:
        return None
    if not isinstance(data, dict):
        return None
    return _coerce_date(data.get("date"))


def _filename_date(path: Path) -> date | None:
    match = _FILENAME_DATE_RE.match(path.name)
    if not match:
        return None
    return _coerce_date(
        f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    )


def _coerce_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def _summarize_opportunity(
    opp: opp_core.Opportunity,
    inventory: list[dict[str, Any]],
    current_criteria_hash: str,
    today: date,
) -> OpportunitySummary:
    deadline = _coerce_date(opp.frontmatter.get("deadline"))
    created = _coerce_date(opp.frontmatter.get("created"))
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
        fit=_read_cached_fit(opp, current_criteria_hash),
    )


def _read_cached_fit(
    opp: opp_core.Opportunity, current_criteria_hash: str
) -> CriteriaFit | None:
    """Return the cached fit summary, or ``None`` if nothing is cached."""
    raw = opp.frontmatter.get("criteria_check")
    if not isinstance(raw, dict):
        return None
    stored_hash = str(raw.get("criteria_hash") or "")
    return CriteriaFit(
        alignment=_coerce_int(raw.get("alignment"), default=0),
        dealbreaker_count=_coerce_int(raw.get("dealbreaker_count"), default=0),
        scored_dimensions=_coerce_int(raw.get("scored_dimensions"), default=0),
        checked_at=_coerce_date(raw.get("checked_at")),
        stale=stored_hash != current_criteria_hash,
    )


def _coerce_int(value: Any, *, default: int) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


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