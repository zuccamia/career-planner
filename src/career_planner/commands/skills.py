"""`career skills` — manage the skills inventory."""

from __future__ import annotations

from typing import Any

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from career_planner.core import skills as skills_core
from career_planner.core import taxonomy
from career_planner.core.workspace import require_workspace
from career_planner.i18n import _

DEFAULT_TREE_DEPTH = 2
DESCRIPTION_PREVIEW_CHARS = 120

console = Console()


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
            _short_code(entry.get("esco_code")),
        )

    console.print(table)


def remove(skill: str) -> None:
    """Remove a skill from the inventory by name or ESCO code."""
    workspace = require_workspace()
    inventory = skills_core.load_inventory(workspace)
    if not inventory:
        console.print(_("Your skills inventory is empty."), style="yellow")
        raise typer.Exit(1)

    matches = skills_core.find_in_inventory(inventory, skill)
    if not matches:
        console.print(
            _("No skill matching '{q}' found in your inventory.").format(q=skill),
            style="red",
        )
        raise typer.Exit(1)

    if len(matches) == 1:
        target_idx, target_entry = matches[0]
    else:
        console.print(_("Multiple skills match '{q}':").format(q=skill))
        for n, (_idx, entry) in enumerate(matches, 1):
            console.print(f"  {n}. {entry.get('skill', '')}")
        choice = typer.prompt(_("Pick a number (or 0 to cancel)"), type=int)
        if choice < 1 or choice > len(matches):
            console.print(_("Cancelled."), style="yellow")
            raise typer.Exit(1)
        target_idx, target_entry = matches[choice - 1]

    del inventory[target_idx]
    skills_core.save_inventory(workspace, inventory)
    console.print(
        _("Removed: {name}").format(name=target_entry.get("skill", "")),
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

    top_skill, top_score = matches[0]
    second_score = matches[1][1] if len(matches) > 1 else 0.0
    if top_score >= 0.999 or (top_score >= 0.85 and top_score - second_score >= 0.1):
        return top_skill.preferred_label, top_skill.uri

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


def _short_code(code: Any) -> str:
    if not code:
        return ""
    s = str(code)
    if "/" in s:
        return s.rsplit("/", 1)[-1][:12]
    return s[:12]


# --- browse ---


def browse(
    search: str | None = None,
    for_occupation: str | None = None,
    vs_occupation: str | None = None,
    depth: int = DEFAULT_TREE_DEPTH,
) -> None:
    """Browse the ESCO skills taxonomy.

    Modes:
      * no flags           – print the skill hierarchy as a tree
      * ``--search``       – ranked list of skills matching the keyword
      * ``--for``          – skill profile for an occupation
      * ``--for`` + ``--vs`` – side-by-side comparison of two occupations
    """
    if vs_occupation and not for_occupation:
        console.print(_("--vs requires --for."), style="red")
        raise typer.Exit(1)
    if search and (for_occupation or vs_occupation):
        console.print(
            _("--search cannot be combined with --for or --vs."),
            style="red",
        )
        raise typer.Exit(1)

    if search:
        _browse_search(search)
    elif for_occupation and vs_occupation:
        _browse_compare(for_occupation, vs_occupation)
    elif for_occupation:
        _browse_for_occupation(for_occupation)
    else:
        _browse_tree(depth=depth)


def _browse_search(query: str) -> None:
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


def _browse_for_occupation(query: str) -> None:
    occupation = _resolve_occupation(query)
    if occupation is None:
        raise typer.Exit(1)

    skills = taxonomy.occupation_skills(occupation.uri)
    _print_occupation_summary(occupation, len(skills))

    if not skills:
        console.print(
            _("No skills mapped to this occupation in the bundled taxonomy."),
            style="yellow",
        )
        return

    by_type: dict[str, list[taxonomy.Skill]] = {}
    for skill in skills:
        by_type.setdefault(skill.skill_type or "other", []).append(skill)

    for type_name in sorted(by_type):
        group = sorted(by_type[type_name], key=lambda s: s.preferred_label)
        table = Table(
            title=_("{type} ({n})").format(type=type_name, n=len(group)),
            show_header=True,
        )
        table.add_column(_("Skill"), style="cyan")
        table.add_column(_("Reuse"), style="dim")
        for skill in group:
            table.add_row(skill.preferred_label, skill.reuse_level)
        console.print(table)


def _browse_compare(query_a: str, query_b: str) -> None:
    occ_a = _resolve_occupation(query_a)
    if occ_a is None:
        raise typer.Exit(1)
    occ_b = _resolve_occupation(query_b)
    if occ_b is None:
        raise typer.Exit(1)
    if occ_a.uri == occ_b.uri:
        console.print(
            _("--for and --vs resolved to the same occupation."),
            style="yellow",
        )
        raise typer.Exit(1)

    skills_a = {s.uri: s for s in taxonomy.occupation_skills(occ_a.uri)}
    skills_b = {s.uri: s for s in taxonomy.occupation_skills(occ_b.uri)}
    overlap = set(skills_a) & set(skills_b)
    only_a = set(skills_a) - set(skills_b)
    only_b = set(skills_b) - set(skills_a)

    console.print(
        Panel(
            _("Overlap: {o}  |  Only {a}: {na}  |  Only {b}: {nb}").format(
                o=len(overlap),
                a=occ_a.preferred_label,
                na=len(only_a),
                b=occ_b.preferred_label,
                nb=len(only_b),
            ),
            title=_("{a}  vs  {b}").format(
                a=occ_a.preferred_label, b=occ_b.preferred_label
            ),
            border_style="cyan",
        )
    )

    table = Table(show_header=True)
    table.add_column(_("Overlap"), style="green")
    table.add_column(_("Only: {n}").format(n=occ_a.preferred_label), style="cyan")
    table.add_column(_("Only: {n}").format(n=occ_b.preferred_label), style="magenta")

    overlap_labels = sorted(skills_a[u].preferred_label for u in overlap)
    only_a_labels = sorted(skills_a[u].preferred_label for u in only_a)
    only_b_labels = sorted(skills_b[u].preferred_label for u in only_b)
    row_count = max(len(overlap_labels), len(only_a_labels), len(only_b_labels))

    for i in range(row_count):
        table.add_row(
            overlap_labels[i] if i < len(overlap_labels) else "",
            only_a_labels[i] if i < len(only_a_labels) else "",
            only_b_labels[i] if i < len(only_b_labels) else "",
        )
    console.print(table)


def _browse_tree(depth: int) -> None:
    parents_of, children_of = taxonomy.load_skill_hierarchy()
    if not children_of:
        console.print(
            _("Skill hierarchy data is not bundled."),
            style="red",
        )
        raise typer.Exit(1)

    roots = taxonomy.hierarchy_roots()
    tree = Tree(_("ESCO skill hierarchy ({n} top-level)").format(n=len(roots)))
    for root_uri in roots:
        skill = taxonomy.find_skill_by_uri(root_uri)
        if skill is None:
            continue
        node = tree.add(f"[cyan]{skill.preferred_label}[/cyan]")
        _add_children(node, root_uri, children_of, remaining=depth)

    console.print(tree)
    console.print(
        _('Tip: career skills browse --search "<keyword>" to narrow down.'),
        style="dim",
    )
    console.print(
        _('     career skills add "<name>" to add to your inventory.'),
        style="dim",
    )


def _add_children(
    node: Tree,
    parent_uri: str,
    children_of: dict[str, tuple[str, ...]],
    *,
    remaining: int,
) -> None:
    if remaining <= 0:
        return
    for child_uri in children_of.get(parent_uri, ()):
        skill = taxonomy.find_skill_by_uri(child_uri)
        if skill is None:
            continue
        child_node = node.add(skill.preferred_label)
        _add_children(
            child_node, child_uri, children_of, remaining=remaining - 1
        )


def _resolve_occupation(query: str) -> taxonomy.Occupation | None:
    matches = taxonomy.find_occupation_matches(query)
    if not matches:
        console.print(
            _("No ESCO occupation matched '{q}'.").format(q=query),
            style="red",
        )
        return None

    top, top_score = matches[0]
    second = matches[1][1] if len(matches) > 1 else 0.0
    if top_score >= 0.999 or (top_score >= 0.85 and top_score - second >= 0.1):
        return top

    console.print(_("Possible ESCO occupations for '{q}':").format(q=query))
    for i, (occ, score) in enumerate(matches, 1):
        console.print(
            f"  {i}. {occ.preferred_label}  "
            f"[dim](ISCO {occ.isco_code}, {score:.2f})[/dim]"
        )
    choice = typer.prompt(_("Pick a number"), type=int, default=1)
    if not 1 <= choice <= len(matches):
        console.print(_("Invalid selection."), style="red")
        return None
    return matches[choice - 1][0]


def _print_occupation_summary(occupation: taxonomy.Occupation, skill_count: int) -> None:
    lines = [
        _("Occupation: {name}").format(name=occupation.preferred_label),
        _("ISCO code: {code}").format(code=occupation.isco_code or "—"),
        _("Skills mapped: {n}").format(n=skill_count),
    ]
    if occupation.description:
        snippet = occupation.description
        if len(snippet) > 240:
            snippet = snippet[:240].rstrip() + "…"
        lines.append("")
        lines.append(snippet)
    console.print(
        Panel(
            "\n".join(lines),
            title=_("ESCO occupation"),
            border_style="cyan",
        )
    )
