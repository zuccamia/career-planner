"""`career timeline` — ASCII timeline of career history and future goals."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

from rich.console import Console
from rich.panel import Panel

from career_planner.core import profile as profile_core
from career_planner.core.workspace import require_workspace
from career_planner.i18n import _

console = Console()

_YYYY_MM_RE = re.compile(r"^(\d{4})-(\d{1,2})$")


@dataclass(frozen=True)
class TimelineEntry:
    """One row on the timeline. ``end`` is None for the current role."""

    role: str
    company: str
    start: tuple[int, int] | None
    end: tuple[int, int] | None
    is_present: bool


def run(today: date | None = None) -> None:
    """Render the timeline from the active workspace's profile."""
    workspace = require_workspace()
    data = profile_core.load_profile(workspace)
    today = today or date.today()

    past, present = _split_history(data, today)
    targets = _collect_targets(data)

    if not past and not present and not targets:
        console.print(
            Panel(
                _(
                    "Your profile is empty. Run `career profile edit` to add "
                    "career history and goals."
                ),
                title=_("Career timeline"),
                border_style="yellow",
            )
        )
        return

    lines: list[str] = []

    if past:
        lines.append(f"[bold]{_('Past')}[/bold]")
        for entry in past:
            lines.append(_format_past_line(entry, today))
        lines.append("")

    if present:
        lines.append(f"[bold]{_('Present')}[/bold]")
        for entry in present:
            lines.append(_format_present_line(entry, today))
        lines.append("")

    if targets:
        lines.append(f"[bold]{_('Targets')}[/bold]")
        lines.extend(targets)

    body = "\n".join(lines).rstrip()
    console.print(
        Panel(body, title=_("Career timeline"), border_style="cyan")
    )


def _split_history(
    data: dict[str, Any], today: date
) -> tuple[list[TimelineEntry], list[TimelineEntry]]:
    """Return (past_entries, present_entries) sorted chronologically."""
    raw = data.get("history")
    history = raw if isinstance(raw, list) else []
    parsed: list[TimelineEntry] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        entry = _parse_history_entry(item)
        if entry is None:
            continue
        parsed.append(entry)

    past = [e for e in parsed if not e.is_present]
    present = [e for e in parsed if e.is_present]

    if not present:
        fallback = _fallback_present(data)
        if fallback is not None:
            present.append(fallback)

    past.sort(key=lambda e: e.start or (0, 0))
    present.sort(key=lambda e: e.start or (0, 0))
    return past, present


def _parse_history_entry(item: dict[str, Any]) -> TimelineEntry | None:
    role = _trim(item.get("role"))
    company = _trim(item.get("company"))
    start_raw = _trim(item.get("start"))
    end_raw = _trim(item.get("end"))

    if not (role or company or start_raw or end_raw):
        return None

    start = _parse_year_month(start_raw)
    is_present = end_raw.lower() == "present"
    end = None if is_present else _parse_year_month(end_raw)

    return TimelineEntry(
        role=role or _("?"),
        company=company or _("?"),
        start=start,
        end=end,
        is_present=is_present,
    )


def _fallback_present(data: dict[str, Any]) -> TimelineEntry | None:
    """Build a present-entry from current_role/current_company if no history says 'present'."""
    role = _trim(data.get("current_role"))
    company = _trim(data.get("current_company"))
    if not role and not company:
        return None
    return TimelineEntry(
        role=role or _("?"),
        company=company or _("?"),
        start=None,
        end=None,
        is_present=True,
    )


def _collect_targets(data: dict[str, Any]) -> list[str]:
    out: list[str] = []
    target_role = _trim(data.get("target_role"))
    target_timeline = _trim(data.get("target_timeline"))
    if target_role:
        if target_timeline:
            out.append(
                "  → "
                + _("{role} (in {when})").format(
                    role=target_role, when=target_timeline
                )
            )
        else:
            out.append("  → " + target_role)

    goals = data.get("goals")
    if isinstance(goals, list):
        for goal in goals:
            text = _trim(goal)
            if text:
                out.append("  → " + text)
    return out


def _format_past_line(entry: TimelineEntry, today: date) -> str:
    start_str = _format_year_month(entry.start) or _("?")
    end_str = _format_year_month(entry.end) or _("?")
    duration = _format_duration(entry.start, entry.end, today, present=False)
    suffix = f"  ({duration})" if duration else ""
    return f"  {start_str} → {end_str}   {entry.role} @ {entry.company}{suffix}"


def _format_present_line(entry: TimelineEntry, today: date) -> str:
    start_str = _format_year_month(entry.start) or _("?")
    duration = _format_duration(entry.start, None, today, present=True)
    suffix = f"  (~{duration})" if duration else ""
    now_label = _("now")
    return (
        f"  ● {start_str} → {now_label}   "
        f"{entry.role} @ {entry.company}{suffix}"
    )


def _format_duration(
    start: tuple[int, int] | None,
    end: tuple[int, int] | None,
    today: date,
    *,
    present: bool,
) -> str:
    if start is None:
        return ""
    if end is None:
        end = (today.year, today.month) if present else None
    if end is None:
        return ""
    months = (end[0] - start[0]) * 12 + (end[1] - start[1])
    if months < 0:
        return ""
    years, rem = divmod(months, 12)
    if years and rem:
        return _("{y}y {m}m").format(y=years, m=rem)
    if years:
        return _("{y}y").format(y=years)
    if rem:
        return _("{m}m").format(m=rem)
    return _("<1m")


def _parse_year_month(text: str) -> tuple[int, int] | None:
    match = _YYYY_MM_RE.match(text)
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
        return None
    return (year, month)


def _format_year_month(value: tuple[int, int] | None) -> str:
    if value is None:
        return ""
    return f"{value[0]:04d}-{value[1]:02d}"


def _trim(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()