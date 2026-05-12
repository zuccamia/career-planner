"""`career profile` — view and edit your career profile."""

from __future__ import annotations

from typing import Any

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from career_planner.core import profile as profile_core
from career_planner.core.workspace import load_config, require_workspace
from career_planner.i18n import _

console = Console()


def edit(use_editor: bool = False) -> None:
    """Edit the profile via guided prompts, or open the raw YAML with --editor."""
    workspace = require_workspace()
    if use_editor:
        _edit_in_editor(workspace)
    else:
        _edit_interactive(workspace)


def _edit_in_editor(workspace: Path) -> None:
    target = profile_core.profile_path(workspace)
    if not target.exists():
        target.touch()

    editor = profile_core.resolve_editor(load_config(workspace))
    try:
        rc = profile_core.open_in_editor(target, editor)
    except FileNotFoundError:
        console.print(
            _(
                "Editor not found: '{ed}'. Set $EDITOR or the `editor` field in "
                "config.yml."
            ).format(ed=editor),
            style="red",
        )
        raise typer.Exit(1) from None

    if rc != 0:
        console.print(
            _("Editor exited with status {n}.").format(n=rc),
            style="yellow",
        )
        raise typer.Exit(rc)


def _edit_interactive(workspace: Path) -> None:
    data = profile_core.load_profile(workspace)

    console.print(
        Panel(
            _(
                "Press Enter to keep the current value.\n"
                "For list fields, type '-' to clear or comma-separate the items."
            ),
            title=_("Edit profile"),
            border_style="cyan",
        )
    )

    data["name"] = _prompt_str(_("Name"), data.get("name"))
    data["current_role"] = _prompt_str(_("Current role"), data.get("current_role"))
    data["current_company"] = _prompt_str(
        _("Current company"), data.get("current_company")
    )
    data["years_experience"] = _prompt_int(
        _("Years of experience"), data.get("years_experience")
    )
    data["target_role"] = _prompt_str(_("Target role"), data.get("target_role"))
    data["target_timeline"] = _prompt_str(
        _("Target timeline"), data.get("target_timeline")
    )

    data["values"] = _prompt_list(_("Values"), data.get("values"))
    data["constraints"] = _prompt_list(_("Constraints"), data.get("constraints"))
    data["goals"] = _prompt_list(_("Goals"), data.get("goals"))

    history = _kept_history(data.get("history"))
    _print_history_summary(history)
    history.extend(_prompt_history_additions())
    data["history"] = history

    profile_core.save_profile(workspace, data)
    console.print(
        _("Saved profile.yml at {path}.").format(
            path=profile_core.profile_path(workspace)
        ),
        style="green",
    )


def _prompt_str(label: str, current: Any) -> str:
    current_str = "" if current is None else str(current)
    return typer.prompt(label, default=current_str, show_default=True)


def _prompt_int(label: str, current: Any) -> int:
    default = 0
    if isinstance(current, int) and not isinstance(current, bool):
        default = current
    elif isinstance(current, str) and current.strip().lstrip("-").isdigit():
        default = int(current.strip())
    while True:
        raw = typer.prompt(label, default=str(default), show_default=True)
        try:
            return int(str(raw).strip())
        except ValueError:
            console.print(_("Please enter a whole number."), style="red")


def _prompt_list(label: str, current: Any) -> list[str]:
    current_items = _as_strings(current)
    default_str = ", ".join(current_items)
    response = typer.prompt(label, default=default_str, show_default=True)
    if response.strip() == "-":
        return []
    return [s.strip() for s in response.split(",") if s.strip()]


def _kept_history(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [h for h in value if isinstance(h, dict) and _has_content(h)]


def _print_history_summary(history: list[dict[str, Any]]) -> None:
    if not history:
        console.print(_("No prior history recorded."), style="dim")
        return
    console.print(_("Existing history (kept as-is):"), style="dim")
    for entry in history:
        role = str(entry.get("role") or "").strip() or "?"
        company = str(entry.get("company") or "").strip() or "?"
        start = str(entry.get("start") or "").strip() or "?"
        end = str(entry.get("end") or "").strip() or "?"
        console.print(f"  - {role} @ {company} ({start} -> {end})", style="dim")


def _prompt_history_additions() -> list[dict[str, Any]]:
    additions: list[dict[str, Any]] = []
    while typer.confirm(_("Add a past role?"), default=False):
        entry = {
            "role": typer.prompt(_("  Role"), default=""),
            "company": typer.prompt(_("  Company"), default=""),
            "start": typer.prompt(_("  Start (YYYY-MM)"), default=""),
            "end": typer.prompt(_("  End (YYYY-MM or 'present')"), default=""),
            "summary": typer.prompt(_("  Summary"), default=""),
        }
        if _has_content(entry):
            additions.append(entry)
        else:
            console.print(_("Skipped empty entry."), style="dim")
    return additions


def show() -> None:
    """Print a formatted summary of the profile."""
    workspace = require_workspace()
    data = profile_core.load_profile(workspace)

    if not _has_content(data):
        console.print(
            Panel(
                _("Your profile is empty. Run `career profile edit` to fill it in."),
                title=_("Career profile"),
                border_style="yellow",
            )
        )
        return

    _render_summary(data)
    _render_lists(data)
    _render_history(data.get("history"))


# --- helpers ---


def _has_content(value: Any) -> bool:
    """Recursive check: does `value` contain any non-empty leaf?"""
    if isinstance(value, dict):
        return any(_has_content(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_content(v) for v in value)
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return value is not None


def _str_or_dash(value: Any) -> str:
    s = ("" if value is None else str(value)).strip()
    return s or "—"


def _render_summary(data: dict[str, Any]) -> None:
    name = _str_or_dash(data.get("name"))
    current_role = _str_or_dash(data.get("current_role"))
    current_company = _str_or_dash(data.get("current_company"))
    years = data.get("years_experience") or 0
    target_role = _str_or_dash(data.get("target_role"))
    target_timeline = _str_or_dash(data.get("target_timeline"))

    lines = [
        _("Name: {v}").format(v=name),
        _("Current: {role} @ {company}").format(
            role=current_role, company=current_company
        ),
        _("Years experience: {n}").format(n=years),
        _("Target role: {role}").format(role=target_role),
        _("Target timeline: {tl}").format(tl=target_timeline),
    ]
    console.print(
        Panel(
            "\n".join(lines),
            title=_("Career profile"),
            border_style="cyan",
        )
    )


def _render_lists(data: dict[str, Any]) -> None:
    sections = [
        (_("Values"), _as_strings(data.get("values"))),
        (_("Constraints"), _as_strings(data.get("constraints"))),
        (_("Goals"), _as_strings(data.get("goals"))),
    ]
    for title, items in sections:
        if items:
            body = "\n".join(f"• {item}" for item in items)
            console.print(Panel(body, title=title, border_style="dim"))


def _as_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        s = ("" if item is None else str(item)).strip()
        if s:
            out.append(s)
    return out


def _render_history(history: Any) -> None:
    if not isinstance(history, list):
        return
    rows = [h for h in history if isinstance(h, dict) and _has_content(h)]
    if not rows:
        return

    table = Table(title=_("Career history"))
    table.add_column(_("Role"), style="cyan")
    table.add_column(_("Company"))
    table.add_column(_("Start"), style="dim")
    table.add_column(_("End"), style="dim")
    table.add_column(_("Summary"))
    for entry in rows:
        table.add_row(
            _str_or_dash(entry.get("role")),
            _str_or_dash(entry.get("company")),
            _str_or_dash(entry.get("start")),
            _str_or_dash(entry.get("end")),
            _str_or_dash(entry.get("summary")),
        )
    console.print(table)
