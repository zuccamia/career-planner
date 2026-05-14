"""`career skills` — manage the skills inventory."""

from __future__ import annotations

from typing import Any

import typer
from rich.panel import Panel
from rich.table import Table

from career_planner.commands._common import console, disambiguate, short_code
from career_planner.core import skills as skills_core
from career_planner.core import taxonomy
from career_planner.core.workspace import require_workspace
from career_planner.i18n import _

DESCRIPTION_PREVIEW_CHARS = 120


def add(
    skill: str,
    rating: int | None = None,
    example: str | None = None,
) -> None:
    """Add a skill to the inventory.

    Fuzzy-matches `skill` against ESCO. Prompts for disambiguation when
    multiple matches are above the confidence threshold, and prompts for
    rating/example when the corresponding flag is omitted.
    """
    workspace = require_workspace()
    inventory = skills_core.load_inventory(workspace)

    resolution = _resolve_taxonomy(skill)
    if resolution is None:
        raise typer.Exit(1)
    label, esco_code = resolution

    if skills_core.is_duplicate(inventory, label, esco_code):
        console.print(
            _("Skill '{name}' is already in your inventory.").format(name=label),
            style="yellow",
        )
        raise typer.Exit(1)

    final_rating = _resolve_rating(rating)
    final_example = _resolve_example(example)

    entry = skills_core.make_entry(
        label=label,
        esco_code=esco_code,
        rating=final_rating,
        example=final_example,
    )
    inventory.append(entry)
    skills_core.save_inventory(workspace, inventory)

    code_line = (
        _("ESCO code: {code}").format(code=esco_code)
        if esco_code
        else _("ESCO code: (none — stored as free-form)")
    )
    console.print(
        Panel(
            "\n".join(
                [
                    _("Added: {name}").format(name=label),
                    _("Rating: {rating}/5").format(rating=final_rating),
                    _("Example: {ex}").format(ex=final_example),
                    code_line,
                ]
            ),
            title=_("Skill added"),
            border_style="green",
        )
    )


def list_skills(category: str | None = None) -> None:
    """Display the skills inventory as a Rich table."""
    workspace = require_workspace()
    inventory = skills_core.load_inventory(workspace)

    if not inventory:
        console.print(
            _("Your skills inventory is empty. Add one with `career skills add`."),
            style="yellow",
        )
        return

    rows = _filter_by_category(inventory, category)
    if not rows:
        console.print(
            _("No skills matched category '{cat}'.").format(cat=category),
            style="yellow",
        )
        return

    table = Table(title=_("Skills inventory"))
    table.add_column(_("Skill"), style="cyan")
    table.add_column(_("Rating"), justify="center")
    table.add_column(_("Example"))
    table.add_column(_("ESCO code"), style="dim")

    for entry in rows:
        table.add_row(
            str(entry.get("skill", "")),
            _format_rating(entry.get("rating")),
            str(entry.get("example", "")),
            short_code(entry.get("esco_code")),
        )

    console.print(table)


def remove(skill: str) -> None:
    """Remove a skill from the inventory by name or ESCO code."""
    workspace = require_workspace()
    inventory = skills_core.load_inventory(workspace)
    if not inventory:
        console.print(_("Your skills inventory is empty."), style="yellow")
        raise typer.Exit(1)

    target = disambiguate(
        skills_core.find_in_inventory(inventory, skill),
        query=skill,
        describe=lambda e: str(e.get("skill", "")),
        not_found=_("No skill matching '{q}' found in your inventory.").format(
            q=skill
        ),
        multiple=_("Multiple skills match '{q}':").format(q=skill),
    )

    inventory.remove(target)
    skills_core.save_inventory(workspace, inventory)
    console.print(
        _("Removed: {name}").format(name=target.get("skill", "")),
        style="green",
    )


# --- helpers ---

def _resolve_taxonomy(query: str) -> tuple[str, str | None] | None:
    """Resolve `query` to an ESCO (label, uri) pair or a free-form label.

    Returns None if the user cancels disambiguation. Returns (label, None)
    when no ESCO match is found or the user opts to store the original query
    as a free-form skill.
    """
    matches = taxonomy.find_skill_matches(query)
    if not matches:
        console.print(
            _("No ESCO match for '{q}' — storing as a free-form skill.").format(
                q=query
            ),
            style="dim",
        )
        return query, None

    confident = taxonomy.is_confident_match(matches)
    if confident is not None:
        return confident.preferred_label, confident.uri

    console.print(_("Possible ESCO matches for '{q}':").format(q=query))
    for i, (skill, score) in enumerate(matches, 1):
        console.print(
            f"  {i}. {skill.preferred_label}  "
            f"[dim]({skill.skill_type}, {score:.2f})[/dim]"
        )
    console.print(
        _("  0. None — store '{q}' as a free-form skill").format(q=query)
    )

    choice = typer.prompt(_("Pick a number"), type=int, default=1)
    if choice == 0:
        return query, None
    if not 1 <= choice <= len(matches):
        console.print(_("Invalid selection."), style="red")
        return None
    chosen, _score = matches[choice - 1]
    return chosen.preferred_label, chosen.uri


def _resolve_rating(rating: int | None) -> int:
    if rating is not None:
        return rating
    while True:
        value = typer.prompt(_("Self-rating (1=beginner, 5=expert)"), type=int)
        if 1 <= value <= 5:
            return value
        console.print(_("Rating must be between 1 and 5."), style="red")


def _resolve_example(example: str | None) -> str:
    if example is not None:
        return example
    return typer.prompt(_("One-line real-world example"))


def _filter_by_category(
    inventory: list[dict[str, Any]], category: str | None
) -> list[dict[str, Any]]:
    if not category:
        return list(inventory)
    needle = category.strip().lower()
    out: list[dict[str, Any]] = []
    for entry in inventory:
        haystack = (entry.get("skill") or "").lower()
        code = entry.get("esco_code")
        if code:
            skill = taxonomy.find_skill_by_uri(str(code))
            if skill:
                haystack = " ".join(
                    [
                        haystack,
                        skill.description.lower(),
                        skill.skill_type.lower(),
                        skill.reuse_level.lower(),
                    ]
                )
        if needle in haystack:
            out.append(entry)
    return out


def _format_rating(rating: Any) -> str:
    try:
        n = int(rating)
    except (TypeError, ValueError):
        return ""
    n = max(0, min(5, n))
    return "*" * n + "." * (5 - n)


# --- browse ---


def browse(query: str) -> None:
    """Search the ESCO skills taxonomy by keyword."""
    matches = taxonomy.search_skills_text(query)
    if not matches:
        console.print(
            _("No ESCO skills matched '{q}'.").format(q=query), style="yellow"
        )
        return

    table = Table(title=_("ESCO skills matching '{q}'").format(q=query))
    table.add_column(_("Skill"), style="cyan")
    table.add_column(_("Type"), style="dim")
    table.add_column(_("Description"))
    table.add_column(_("Score"), justify="right", style="dim")

    for skill, score in matches:
        desc = skill.description or ""
        if len(desc) > DESCRIPTION_PREVIEW_CHARS:
            desc = desc[:DESCRIPTION_PREVIEW_CHARS].rstrip() + "…"
        table.add_row(
            skill.preferred_label,
            skill.skill_type,
            desc,
            f"{score:.2f}",
        )
    console.print(table)
    console.print(
        _('To add one: career skills add "<name>"'),
        style="dim",
    )
