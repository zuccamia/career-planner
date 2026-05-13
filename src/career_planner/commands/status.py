"""`career status` — dashboard of workspace health and freshness."""

from __future__ import annotations

from datetime import date

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from career_planner.core import status as status_core
from career_planner.core.workspace import require_workspace
from career_planner.i18n import _

console = Console()

_BAR_WIDTH = 10


def run(today: date | None = None) -> None:
    """Render the status dashboard for the active workspace."""
    workspace = require_workspace()
    report = status_core.gather(workspace, today=today)

    console.print(
        Panel(
            _summary_block(report),
            title=_("Career status"),
            border_style="cyan",
        )
    )

    if report.upcoming_deadlines:
        console.print(_deadlines_table(report))

    if report.active_opportunities:
        console.print(_coverage_table(report))

    if report.warnings:
        console.print(_warnings_panel(report))


def _summary_block(report: status_core.StatusReport) -> str:
    lines: list[str] = []

    lines.append(
        _("Profile completeness: {pct}% ({filled}/{total})").format(
            pct=report.profile_completeness,
            filled=report.profile_filled_fields,
            total=report.profile_total_fields,
        )
    )
    if report.profile_missing:
        lines.append(
            _("  Missing: {fields}").format(
                fields=", ".join(report.profile_missing)
            )
        )

    lines.append("")
    lines.append(_skills_line(report))
    lines.append(_brag_line(report))

    lines.append("")
    lines.append(
        _("Active opportunities: {n}").format(n=len(report.active_opportunities))
    )
    if report.stale_opportunities:
        lines.append(
            _("  Stale (no update 30+ days): {n}").format(
                n=len(report.stale_opportunities)
            )
        )
    return "\n".join(lines)


def _skills_line(report: status_core.StatusReport) -> str:
    if report.skills_count == 0:
        return _("Skills inventory: 0 — run `career skills add`.")
    if report.skills_last_updated is None:
        return _("Skills inventory: {n} (no dates recorded)").format(
            n=report.skills_count
        )
    return _(
        "Skills inventory: {n} (last updated {when}, {days}d ago)"
    ).format(
        n=report.skills_count,
        when=report.skills_last_updated.isoformat(),
        days=report.days_since_skills_update,
    )


def _brag_line(report: status_core.StatusReport) -> str:
    if report.brag_count == 0:
        return _("Brag entries: 0 — run `career brag add` to capture a win.")
    if report.last_brag_date is None:
        return _("Brag entries: {n} (no dates recorded)").format(
            n=report.brag_count
        )
    return _(
        "Brag entries: {n} (last {when}, {days}d ago)"
    ).format(
        n=report.brag_count,
        when=report.last_brag_date.isoformat(),
        days=report.days_since_last_brag,
    )


def _deadlines_table(report: status_core.StatusReport) -> Table:
    table = Table(
        title=_("Upcoming deadlines (next {n} days)").format(
            n=status_core.DEADLINE_HORIZON_DAYS
        )
    )
    table.add_column(_("Opportunity"), style="cyan")
    table.add_column(_("Deadline"))
    table.add_column(_("In"), justify="right")
    for opp in report.upcoming_deadlines:
        when = opp.deadline.isoformat() if opp.deadline else ""
        in_days = (
            _("{d}d").format(d=opp.days_until_deadline)
            if opp.days_until_deadline is not None
            else ""
        )
        table.add_row(opp.title, when, in_days)
    return table


def _coverage_table(report: status_core.StatusReport) -> Table:
    table = Table(title=_("Active opportunities"))
    table.add_column(_("Role"), style="cyan")
    table.add_column(_("Company"))
    table.add_column(_("Location"))
    table.add_column(_("Type"))
    table.add_column(_("Status"))
    table.add_column(_("Age"), justify="right")
    table.add_column(_("Coverage"))
    table.add_column(_("Fit"))
    for opp in report.active_opportunities:
        table.add_row(
            opp.role or opp.title,
            opp.company or _("—"),
            opp.location_short or _("—"),
            opp.work_type or _("—"),
            opp.status or _("—"),
            _format_age(opp),
            _format_coverage(opp),
            _format_fit(opp),
        )
    return table


def _format_age(opp: status_core.OpportunitySummary) -> str:
    if opp.days_since_created is None:
        return _("—")
    return _("{d}d").format(d=opp.days_since_created)


def _format_coverage(opp: status_core.OpportunitySummary) -> str:
    if opp.coverage is None:
        return _("—")
    bar = _render_bar(opp.coverage)
    return f"{bar} {round(opp.coverage * 100)}%"


def _format_fit(opp: status_core.OpportunitySummary) -> str:
    fit = opp.fit
    if fit is None:
        return _("—")
    if fit.stale:
        return _("[yellow]stale[/yellow]")
    if fit.has_violations:
        return f"[red]⚠ {fit.dealbreaker_count}[/red]"
    if fit.scored_dimensions == 0:
        return _("—")
    suffix = " 🤖" if fit.ai_augmented else ""
    return f"{fit.alignment}%{suffix}"


def _render_bar(coverage: float) -> str:
    filled = min(_BAR_WIDTH, max(0, round(coverage * _BAR_WIDTH)))
    return "█" * filled + "░" * (_BAR_WIDTH - filled)


def _warnings_panel(report: status_core.StatusReport) -> Panel:
    body = "\n".join(f"• {w}" for w in report.warnings)
    return Panel(body, title=_("Warnings"), border_style="yellow")