"""`career criteria` — view, edit, and check your job criteria."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import typer
from rich.panel import Panel
from rich.table import Table

from career_planner.commands._common import console, resolve_opportunity
from career_planner.core import criteria as criteria_core
from career_planner.core import llm as llm_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    require_workspace,
    resolve_editor,
)
from career_planner.i18n import _


# --- edit ---


def edit(use_editor: bool = False) -> None:
    """Edit job criteria via guided prompts, or open the raw YAML with --editor."""
    workspace = require_workspace()
    if use_editor:
        _edit_in_editor(workspace)
    else:
        _edit_interactive(workspace)


def _edit_in_editor(workspace: Path) -> None:
    target = criteria_core.criteria_path(workspace)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()

    editor = resolve_editor(load_config(workspace))
    try:
        rc = open_in_editor(target, editor)
    except FileNotFoundError:
        console.print(
            _(
                "Editor not found: '{ed}'. Set $EDITOR or the `editor` field "
                "in config.yml. Edit the file manually at:\n{path}"
            ).format(ed=editor, path=target),
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
    data = criteria_core.load_criteria(workspace)
    for dim in criteria_core.DIMENSIONS:
        if not isinstance(data.get(dim), dict):
            data[dim] = {}

    console.print(
        Panel(
            _(
                "Press Enter to keep the current value.\n"
                "For list fields, comma-separate items; type '-' to clear."
            ),
            title=_("Edit criteria"),
            border_style="cyan",
        )
    )

    _edit_function(data["function"])
    _edit_culture(data["culture"])
    _edit_growth(data["growth"])
    _edit_compensation(data["compensation"])
    _edit_location(data["location"])

    criteria_core.save_criteria(workspace, data)
    console.print(
        _("Saved criteria.yml at {path}.").format(
            path=criteria_core.criteria_path(workspace)
        ),
        style="green",
    )


def _edit_function(d: dict[str, Any]) -> None:
    _dimension_header(_("Function — the work itself"))
    d["want"] = _prompt_list(
        _("What kind of day-to-day work do you enjoy?"),
        d.get("want"),
        example=_("hands-on backend coding, system design"),
    )
    d["dread"] = _prompt_list(
        _("What work would you dread doing?"),
        d.get("dread"),
        example=_("pure people management with no coding"),
    )
    d["dealbreakers"] = _prompt_list(
        _("What kinds of work are absolute dealbreakers?"),
        d.get("dealbreakers"),
        example=_("no coding at all in the role"),
    )


def _edit_culture(d: dict[str, Any]) -> None:
    _dimension_header(_("Culture — the environment"))
    d["preferred"] = _prompt_list(
        _("What work environments do you thrive in?"),
        d.get("preferred"),
        example=_("small team, async-first communication"),
    )
    d["avoid"] = _prompt_list(
        _("What environments drain you or you'd rather avoid?"),
        d.get("avoid"),
        example=_("micromanagement, meeting-heavy culture"),
    )
    d["dealbreakers"] = _prompt_list(
        _("What cultural patterns are dealbreakers?"),
        d.get("dealbreakers"),
        example=_("mandatory 5-day in-office"),
    )


def _edit_growth(d: dict[str, Any]) -> None:
    _dimension_header(_("Growth — where you're headed"))
    d["goal_2_3_years"] = _prompt_str(
        _("Where do you want to be in 2–3 years?"),
        d.get("goal_2_3_years"),
        example=_("staff engineer or technical lead"),
    )
    d["motivators"] = _prompt_list(
        _("What motivates you and makes you feel like you're growing?"),
        d.get("motivators"),
        example=_("hard technical problems, mentoring juniors"),
    )
    d["stuck_signals"] = _prompt_list(
        _("What would make you feel stuck or stagnant?"),
        d.get("stuck_signals"),
        example=_("no promotion path beyond senior"),
    )
    d["dealbreakers"] = _prompt_list(
        _("What growth-related issues are dealbreakers?"),
        d.get("dealbreakers"),
        example=_("no learning or education budget"),
    )


def _edit_compensation(d: dict[str, Any]) -> None:
    _dimension_header(_("Compensation — pay and perks"))
    d["base_minimum"] = _prompt_int(
        _("What's the minimum base salary you'd consider? (0 = unset)"),
        d.get("base_minimum"),
        example=_("150000"),
    )
    d["base_target"] = _prompt_int(
        _("What base salary are you aiming for? (0 = unset)"),
        d.get("base_target"),
        example=_("180000"),
    )
    d["currency"] = _prompt_str(
        _("Which currency are those numbers in?"),
        d.get("currency") or "USD",
    )
    d["other_important"] = _prompt_list(
        _("What other compensation matters (equity, PTO, benefits, …)?"),
        d.get("other_important"),
        example=_("equity with 4-year vest, health insurance, 20+ PTO days"),
    )
    d["dealbreakers"] = _prompt_list(
        _("What compensation issues are dealbreakers?"),
        d.get("dealbreakers"),
        example=_("no health insurance, base below your floor"),
    )


def _edit_location(d: dict[str, Any]) -> None:
    _dimension_header(_("Location — where and how"))
    d["preferred"] = _prompt_list(
        _("Where would you prefer to live or work from?"),
        d.get("preferred"),
        example=_("San Francisco Bay Area, Remote (US time zones)"),
    )
    d["willing_to_relocate"] = _prompt_bool(
        _("Are you open to relocating for the right role?"),
        d.get("willing_to_relocate"),
    )
    d["work_type"] = _prompt_str(
        _("What work arrangement do you want?"),
        d.get("work_type"),
        example=_("remote, hybrid, or remote-or-hybrid"),
    )
    d["constraints"] = _prompt_list(
        _("Any geographic or work-permit constraints to flag?"),
        d.get("constraints"),
        example=_("need US work-authorization sponsorship"),
    )
    d["dealbreakers"] = _prompt_list(
        _("What location-related issues are dealbreakers?"),
        d.get("dealbreakers"),
        example=_("fully in-person required"),
    )


def _dimension_header(title: str) -> None:
    console.print()
    console.print(title, style="bold cyan")


# --- prompt helpers ---


def _show_example(example: str) -> None:
    if example:
        console.print(f"  [dim]e.g. {example}[/dim]")


def _prompt_str(label: str, current: Any, *, example: str = "") -> str:
    _show_example(example)
    current_str = "" if current is None else str(current)
    return typer.prompt(label, default=current_str, show_default=True)


def _prompt_int(label: str, current: Any, *, example: str = "") -> int:
    _show_example(example)
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


def _prompt_list(label: str, current: Any, *, example: str = "") -> list[str]:
    _show_example(example)
    current_items: list[str] = []
    if isinstance(current, list):
        for item in current:
            s = ("" if item is None else str(item)).strip()
            if s:
                current_items.append(s)
    default_str = ", ".join(current_items)
    response = typer.prompt(label, default=default_str, show_default=True)
    if response.strip() == "-":
        return []
    return [s.strip() for s in response.split(",") if s.strip()]


def _prompt_bool(label: str, current: Any) -> bool:
    default = bool(current) if isinstance(current, bool) else False
    return typer.confirm(label, default=default)


# --- show ---


def show() -> None:
    """Print a formatted summary of the current job criteria."""
    workspace = require_workspace()
    data = criteria_core.load_criteria(workspace)

    if not data:
        console.print(
            Panel(
                _(
                    "Your criteria file is empty. Run `career criteria edit` "
                    "to fill it in."
                ),
                title=_("Job criteria"),
                border_style="yellow",
            )
        )
        return

    empty_dims: list[str] = []
    for dim in criteria_core.DIMENSIONS:
        dim_data = criteria_core.dimension_data(data, dim)
        if criteria_core.is_dimension_empty(dim, dim_data):
            empty_dims.append(dim)
            console.print(
                Panel(
                    _("(empty — fill in with `career criteria edit`)"),
                    title=_dimension_title(dim),
                    border_style="yellow",
                )
            )
            continue
        console.print(
            Panel(
                _render_dimension_body(dim, dim_data),
                title=_dimension_title(dim),
                border_style="cyan",
            )
        )

    if empty_dims:
        names = ", ".join(_dimension_label(d) for d in empty_dims)
        console.print(
            _("Incomplete dimensions: {names}.").format(names=names),
            style="yellow",
        )
    else:
        console.print(_("All five dimensions have content."), style="green")


def _dimension_title(name: str) -> str:
    return _("Criteria — {dim}").format(dim=_dimension_label(name))


_DIMENSION_LABELS: dict[str, str] = {
    "function": "Function",
    "culture": "Culture",
    "growth": "Growth",
    "compensation": "Compensation",
    "location": "Location",
}


def _dimension_label(name: str) -> str:
    raw = _DIMENSION_LABELS.get(name, name.title())
    return _(raw)


# Per-dimension field display order and pretty labels.
_FIELD_LABELS: dict[str, list[tuple[str, str]]] = {
    "function": [
        ("want", "Want"),
        ("dread", "Dread"),
        ("dealbreakers", "Dealbreakers"),
    ],
    "culture": [
        ("preferred", "Preferred"),
        ("avoid", "Avoid"),
        ("dealbreakers", "Dealbreakers"),
    ],
    "growth": [
        ("goal_2_3_years", "Goal (2–3 years)"),
        ("motivators", "Motivators"),
        ("stuck_signals", "Stuck signals"),
        ("dealbreakers", "Dealbreakers"),
    ],
    "compensation": [
        ("base_minimum", "Base minimum"),
        ("base_target", "Base target"),
        ("currency", "Currency"),
        ("other_important", "Other important"),
        ("dealbreakers", "Dealbreakers"),
    ],
    "location": [
        ("preferred", "Preferred"),
        ("willing_to_relocate", "Willing to relocate"),
        ("work_type", "Work type"),
        ("constraints", "Constraints"),
        ("dealbreakers", "Dealbreakers"),
    ],
}


def _render_dimension_body(name: str, data: dict[str, Any]) -> str:
    lines: list[str] = []
    for key, label in _FIELD_LABELS.get(name, []):
        if key not in data:
            continue
        rendered = _render_field(data.get(key))
        if rendered is None:
            continue
        lines.append(f"{_(label)}: {rendered}")
    return "\n".join(lines) if lines else _("(no fields set)")


def _render_field(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return _("yes") if value else _("no")
    if isinstance(value, (int, float)):
        return "" if value == 0 else str(value)
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, list):
        items = [str(item).strip() for item in value if str(item).strip()]
        if not items:
            return None
        return "\n  " + "\n  ".join(f"• {item}" for item in items)
    return str(value)


# --- check ---


def check(opportunity: str) -> None:
    """Check an opportunity against the user's criteria via the configured LLM.

    Exits 3 if no LLM provider is configured. Network/API/parse failures
    print the error and exit 1.
    """
    workspace = require_workspace()

    data = criteria_core.load_criteria(workspace)
    if not data:
        console.print(
            _(
                "No criteria configured. Run `career criteria edit` to set "
                "your job preferences first."
            ),
            style="red",
        )
        raise typer.Exit(1)

    opp = resolve_opportunity(workspace, opportunity)

    try:
        config = llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        console.print(
            _(
                "`criteria check` needs an LLM provider in config.yml: {err}"
            ).format(err=exc),
            style="red",
        )
        raise typer.Exit(3) from None

    with console.status(_("Reasoning with {model}…").format(model=config.model)):
        try:
            result = criteria_core.check_against_opportunity(data, opp, config)
        except llm_core.LLMError as exc:
            console.print(
                _("LLM check failed: {err}").format(err=exc),
                style="red",
            )
            raise typer.Exit(1) from None

    criteria_core.save_check_to_opportunity(workspace, result, data)

    _render_check_header(result)
    if result.has_violations:
        _render_violations(result)
    _render_dimensions(result)


def _render_check_header(result: criteria_core.CriteriaCheck) -> None:
    alignment_pct = int(round(result.alignment * 100))
    border = "red" if result.has_violations else "green"
    lines = [
        _("Opportunity: {t}").format(t=result.opportunity_title),
        _("Slug: {s}").format(s=result.opportunity_slug),
        _("Alignment: {pct}%  ({v} dealbreaker violations)").format(
            pct=alignment_pct, v=len(result.violations)
        ),
    ]
    if result.summary:
        lines.append("")
        lines.append(result.summary)
    console.print(
        Panel(
            "\n".join(lines),
            title=_("Criteria check"),
            border_style=border,
        )
    )


def _render_violations(result: criteria_core.CriteriaCheck) -> None:
    table = Table(
        title=_("Dealbreaker violations ({n})").format(n=len(result.violations)),
        title_style="red",
    )
    table.add_column(_("Dimension"), style="cyan")
    table.add_column(_("Phrase"))
    table.add_column(_("Context"))

    for violation in result.violations:
        table.add_row(
            _dimension_label(violation.dimension),
            violation.phrase,
            violation.context or "—",
        )
    console.print(table)


def _render_dimensions(result: criteria_core.CriteriaCheck) -> None:
    table = Table(title=_("Dimension alignment"), title_style="cyan")
    table.add_column(_("Dimension"), style="cyan")
    table.add_column(_("Status"), justify="center")
    table.add_column(_("Summary"))

    for dim in result.dimensions:
        table.add_row(
            _dimension_label(dim.name),
            _format_status(dim.status),
            dim.summary or "—",
        )
    console.print(table)
    _render_dimension_details(result)


def _format_status(status: str) -> str:
    style = {
        criteria_core.STATUS_STRONG: "[green]strong[/green]",
        criteria_core.STATUS_OK: "[green]ok[/green]",
        criteria_core.STATUS_WEAK: "[yellow]weak[/yellow]",
        criteria_core.STATUS_VIOLATION: "[red]violation[/red]",
        criteria_core.STATUS_UNKNOWN: "[dim]unknown[/dim]",
    }
    return style.get(status, status)


def _render_dimension_details(result: criteria_core.CriteriaCheck) -> None:
    """Print the per-dimension positives/negatives with quoted context."""
    for dim in result.dimensions:
        if not (dim.positives or dim.negatives):
            continue
        lines: list[str] = []
        for match in dim.positives:
            lines.append(f"+ {match.phrase}: {match.context}")
        for match in dim.negatives:
            lines.append(f"- {match.phrase}: {match.context}")
        console.print(
            Panel(
                "\n".join(lines),
                title=_("Matches — {dim}").format(
                    dim=_dimension_label(dim.name)
                ),
                border_style="dim",
            )
        )
