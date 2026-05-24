"""`career criteria` — view, edit, and check your job criteria."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import typer
from rich.panel import Panel
from rich.table import Table

from career_planner.commands._common import (
    console,
    edit_file_in_editor,
    fail,
    llm_status_or_exit,
    load_llm_config_or_exit,
    resolve_opportunity,
)
from career_planner.core import criteria as criteria_core
from career_planner.core.workspace import require_workspace
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
    edit_file_in_editor(workspace, target, must_edit=True)


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

    for spec in CRITERIA_SCHEMA:
        _edit_dimension(spec, data[spec.key])

    criteria_core.save_criteria(workspace, data)
    console.print(
        _("Saved criteria.yml at {path}.").format(
            path=criteria_core.criteria_path(workspace)
        ),
        style="green",
    )


def _edit_dimension(spec: CriteriaDimensionSpec, data: dict[str, Any]) -> None:
    _dimension_header(_(spec.header))
    for field in spec.fields:
        data[field.key] = _prompt_field_value(field, data.get(field.key))


def _prompt_field_value(field: CriteriaFieldSpec, current: Any) -> Any:
    current_value = current
    if current_value in (None, "") and field.default_value is not None:
        current_value = field.default_value

    prompt = _(field.prompt)
    example = _(field.example) if field.example else ""
    if field.kind == "str":
        return _prompt_str(prompt, current_value, example=example)
    if field.kind == "int":
        return _prompt_int(prompt, current_value, example=example)
    if field.kind == "list":
        return _prompt_list(prompt, current_value, example=example)
    if field.kind == "bool":
        return _prompt_bool(prompt, current_value)
    raise AssertionError(f"Unsupported criteria field kind: {field.kind}")


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


@dataclass(frozen=True)
class CriteriaFieldSpec:
    key: str
    label: str
    prompt: str
    kind: str
    example: str = ""
    default_value: Any = None


@dataclass(frozen=True)
class CriteriaDimensionSpec:
    key: str
    label: str
    header: str
    fields: tuple[CriteriaFieldSpec, ...]


CRITERIA_SCHEMA: tuple[CriteriaDimensionSpec, ...] = (
    CriteriaDimensionSpec(
        key="function",
        label="Function",
        header="Function — the work itself",
        fields=(
            CriteriaFieldSpec(
                key="want",
                label="Want",
                prompt="What kind of day-to-day work do you enjoy?",
                kind="list",
                example="hands-on backend coding, system design",
            ),
            CriteriaFieldSpec(
                key="dread",
                label="Dread",
                prompt="What work would you dread doing?",
                kind="list",
                example="pure people management with no coding",
            ),
            CriteriaFieldSpec(
                key="dealbreakers",
                label="Dealbreakers",
                prompt="What kinds of work are absolute dealbreakers?",
                kind="list",
                example="no coding at all in the role",
            ),
        ),
    ),
    CriteriaDimensionSpec(
        key="culture",
        label="Culture",
        header="Culture — the environment",
        fields=(
            CriteriaFieldSpec(
                key="preferred",
                label="Preferred",
                prompt="What work environments do you thrive in?",
                kind="list",
                example="small team, async-first communication",
            ),
            CriteriaFieldSpec(
                key="avoid",
                label="Avoid",
                prompt="What environments drain you or you'd rather avoid?",
                kind="list",
                example="micromanagement, meeting-heavy culture",
            ),
            CriteriaFieldSpec(
                key="dealbreakers",
                label="Dealbreakers",
                prompt="What cultural patterns are dealbreakers?",
                kind="list",
                example="mandatory 5-day in-office",
            ),
        ),
    ),
    CriteriaDimensionSpec(
        key="growth",
        label="Growth",
        header="Growth — where you're headed",
        fields=(
            CriteriaFieldSpec(
                key="goal_2_3_years",
                label="Goal (2–3 years)",
                prompt="Where do you want to be in 2–3 years?",
                kind="str",
                example="staff engineer or technical lead",
            ),
            CriteriaFieldSpec(
                key="motivators",
                label="Motivators",
                prompt="What motivates you and makes you feel like you're growing?",
                kind="list",
                example="hard technical problems, mentoring juniors",
            ),
            CriteriaFieldSpec(
                key="stuck_signals",
                label="Stuck signals",
                prompt="What would make you feel stuck or stagnant?",
                kind="list",
                example="no promotion path beyond senior",
            ),
            CriteriaFieldSpec(
                key="dealbreakers",
                label="Dealbreakers",
                prompt="What growth-related issues are dealbreakers?",
                kind="list",
                example="no learning or education budget",
            ),
        ),
    ),
    CriteriaDimensionSpec(
        key="compensation",
        label="Compensation",
        header="Compensation — pay and perks",
        fields=(
            CriteriaFieldSpec(
                key="base_minimum",
                label="Base minimum",
                prompt="What's the minimum base salary you'd consider? (0 = unset)",
                kind="int",
                example="150000",
            ),
            CriteriaFieldSpec(
                key="base_target",
                label="Base target",
                prompt="What base salary are you aiming for? (0 = unset)",
                kind="int",
                example="180000",
            ),
            CriteriaFieldSpec(
                key="currency",
                label="Currency",
                prompt="Which currency are those numbers in?",
                kind="str",
                default_value="USD",
            ),
            CriteriaFieldSpec(
                key="other_important",
                label="Other important",
                prompt="What other compensation matters (equity, PTO, benefits, …)?",
                kind="list",
                example="equity with 4-year vest, health insurance, 20+ PTO days",
            ),
            CriteriaFieldSpec(
                key="dealbreakers",
                label="Dealbreakers",
                prompt="What compensation issues are dealbreakers?",
                kind="list",
                example="no health insurance, base below your floor",
            ),
        ),
    ),
    CriteriaDimensionSpec(
        key="location",
        label="Location",
        header="Location — where and how",
        fields=(
            CriteriaFieldSpec(
                key="preferred",
                label="Preferred",
                prompt="Where would you prefer to live or work from?",
                kind="list",
                example="San Francisco Bay Area, Remote (US time zones)",
            ),
            CriteriaFieldSpec(
                key="willing_to_relocate",
                label="Willing to relocate",
                prompt="Are you open to relocating for the right role?",
                kind="bool",
            ),
            CriteriaFieldSpec(
                key="work_type",
                label="Work type",
                prompt="What work arrangement do you want?",
                kind="str",
                example="remote, hybrid, or remote-or-hybrid",
            ),
            CriteriaFieldSpec(
                key="constraints",
                label="Constraints",
                prompt="Any geographic or work-permit constraints to flag?",
                kind="list",
                example="need US work-authorization sponsorship",
            ),
            CriteriaFieldSpec(
                key="dealbreakers",
                label="Dealbreakers",
                prompt="What location-related issues are dealbreakers?",
                kind="list",
                example="fully in-person required",
            ),
        ),
    ),
)

_DIMENSION_SPECS: dict[str, CriteriaDimensionSpec] = {
    spec.key: spec for spec in CRITERIA_SCHEMA
}


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


def _dimension_label(name: str) -> str:
    spec = _DIMENSION_SPECS.get(name)
    raw = spec.label if spec is not None else name.title()
    return _(raw)


def _render_dimension_body(name: str, data: dict[str, Any]) -> str:
    spec = _DIMENSION_SPECS.get(name)
    if spec is None:
        return _("(no fields set)")

    lines: list[str] = []
    for field in spec.fields:
        if field.key not in data:
            continue
        rendered = _render_field(data.get(field.key))
        if rendered is None:
            continue
        lines.append(f"{_(field.label)}: {rendered}")
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
        fail(
            _(
                "No criteria configured. Run `career criteria edit` to set "
                "your job preferences first."
            )
        )

    opp = resolve_opportunity(workspace, opportunity)

    config = load_llm_config_or_exit(
        workspace,
        missing_message=_(
            "`criteria check` needs an LLM provider in config.yml: {err}"
        ),
    )

    with llm_status_or_exit(
        status_message=_("Reasoning with {model}…").format(model=config.model),
        failure_message=_("LLM check failed: {err}"),
    ):
        result = criteria_core.check_against_opportunity(data, opp, config)

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
