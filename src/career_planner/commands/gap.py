"""`career gap` — compare your skills against an opportunity's requirements."""

from __future__ import annotations

import typer
from rich.console import Console
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table

from career_planner.core import gap as gap_core
from career_planner.core import opportunities as opp_core
from career_planner.core import skills as skills_core
from career_planner.core.workspace import require_workspace
from career_planner.i18n import _

console = Console()


def run(opportunity: str, *, suggest: bool = False) -> None:
    """Run a skill gap analysis for `opportunity`.

    Resolves the opportunity by slug (with disambiguation), parses its
    ``required_skills`` field, then renders matched / partial / missing
    skills as Rich tables. ``--suggest`` is a placeholder for the AI
    layer and prints a hint when no LLM is wired up.
    """
    workspace = require_workspace()

    opp = _resolve_opportunity(workspace, opportunity)
    inventory = skills_core.load_inventory(workspace)
    requirements = gap_core.parse_requirements(
        opp.frontmatter.get("required_skills")
    )

    if requirements:
        analysis = gap_core.analyze(inventory, requirements)
        _render_header(opp, analysis)
        _render_matched(analysis)
        _render_partial(analysis)
        _render_missing(analysis)
        if suggest:
            _print_suggest_stub()
        return

    # No curated requirements — fall back to scanning the description for
    # the user's own inventory skills (closed set, low noise). Missing
    # skills can't be extracted reliably from prose, so we don't try.
    description = gap_core.extract_description_section(opp.body)
    hits = (
        gap_core.find_inventory_skills_in_text(inventory, description)
        if description
        else []
    )
    _render_fallback(opp, hits, has_description=bool(description))

    if suggest:
        _print_suggest_stub()


# --- rendering helpers ---


def _render_header(
    opp: opp_core.Opportunity, analysis: gap_core.GapAnalysis
) -> None:
    total = len(analysis.matches)
    coverage_pct = int(round(analysis.coverage * 100))
    lines = [
        _("Opportunity: {t}").format(t=opp.title),
        _("Slug: {s}").format(s=opp.slug),
        _(
            "Coverage: {pct}%  ({matched} matched, {partial} partial, "
            "{missing} missing, {total} required)"
        ).format(
            pct=coverage_pct,
            matched=len(analysis.matched),
            partial=len(analysis.partial),
            missing=len(analysis.missing),
            total=total,
        ),
    ]
    border = _coverage_border(analysis)
    console.print(
        Panel(
            "\n".join(lines),
            title=_("Skill gap analysis"),
            border_style=border,
        )
    )


def _coverage_border(analysis: gap_core.GapAnalysis) -> str:
    if analysis.missing or analysis.partial:
        if analysis.missing and not analysis.matched:
            return "red"
        return "yellow"
    return "green"


def _render_matched(analysis: gap_core.GapAnalysis) -> None:
    if not analysis.matched:
        return
    table = Table(
        title=_("Matched ({n})").format(n=len(analysis.matched)),
        title_style="green",
    )
    table.add_column(_("Skill"), style="cyan")
    table.add_column(_("Your rating"), justify="center")
    table.add_column(_("Example"))
    table.add_column(_("ESCO code"), style="dim")

    for match in analysis.matched:
        table.add_row(
            match.requirement.label,
            _format_rating_cell(match.rating, match.requirement.min_rating),
            match.example,
            _short_code(match.requirement.esco_code),
        )
    console.print(table)


def _render_partial(analysis: gap_core.GapAnalysis) -> None:
    if not analysis.partial:
        return
    table = Table(
        title=_("Partial — below required level ({n})").format(
            n=len(analysis.partial)
        ),
        title_style="yellow",
    )
    table.add_column(_("Skill"), style="cyan")
    table.add_column(_("Your rating"), justify="center")
    table.add_column(_("Required"), justify="center")
    table.add_column(_("Example"))

    for match in analysis.partial:
        table.add_row(
            match.requirement.label,
            _format_rating_cell(match.rating, match.requirement.min_rating),
            f"{match.requirement.min_rating}/5"
            if match.requirement.min_rating is not None
            else "—",
            match.example,
        )
    console.print(table)


def _render_missing(analysis: gap_core.GapAnalysis) -> None:
    if not analysis.missing:
        return
    table = Table(
        title=_("Missing ({n})").format(n=len(analysis.missing)),
        title_style="red",
    )
    table.add_column(_("Skill"), style="cyan")
    table.add_column(_("Required"), justify="center")
    table.add_column(_("ESCO code"), style="dim")

    for match in analysis.missing:
        req = match.requirement
        table.add_row(
            req.label,
            f"{req.min_rating}/5" if req.min_rating is not None else "—",
            _short_code(req.esco_code),
        )
    console.print(table)
    console.print(
        _(
            'Tip: add a missing skill with `career skills add "<name>"` '
            "once you've practiced it."
        ),
        style="dim",
    )


def _format_rating_cell(rating: int | None, required: int | None) -> str:
    """Render a rating like ``****.  (4/5)`` with an optional threshold."""
    if rating is None:
        return "—"
    stars = "*" * rating + "." * (5 - rating)
    label = f"{stars}  ({rating}/5)"
    if required is not None and rating < required:
        label += f"  < {required}/5"
    return label


def _render_fallback(
    opp: opp_core.Opportunity,
    hits: list[gap_core.InventoryHit],
    *,
    has_description: bool,
) -> None:
    """Render the no-requirements path: which of my skills are mentioned, plus a warning.

    Pure software can't reliably extract what's *missing* from prose, so
    we deliberately don't try. We show the user which of their existing
    skills the posting mentions (closed-set scan, low noise) and point
    them at the AI parser for full extraction.
    """
    console.print(
        Panel(
            "\n".join(
                [
                    _("Opportunity: {t}").format(t=opp.title),
                    _("Slug: {s}").format(s=opp.slug),
                    _(
                        "required_skills is empty — showing which of your "
                        "inventory skills appear in the description."
                    ),
                ]
            ),
            title=_("Skill gap analysis (partial)"),
            border_style="yellow",
        )
    )

    if hits:
        table = Table(
            title=_("Your skills mentioned in the description ({n})").format(
                n=len(hits)
            ),
            title_style="green",
        )
        table.add_column(_("Skill"), style="cyan")
        table.add_column(_("Your rating"), justify="center")
        table.add_column(_("Example"))
        table.add_column(_("Context from posting"))

        for hit in hits:
            table.add_row(
                hit.label,
                _format_rating_cell(hit.rating, None),
                hit.example,
                f"[dim italic]{escape(hit.context)}[/dim italic]"
                if hit.context
                else "",
            )
        console.print(table)
    elif has_description:
        console.print(
            _(
                "None of your inventory skills appear verbatim in the "
                "description."
            ),
            style="yellow",
        )
    else:
        console.print(
            _("Opportunity has no description to scan."),
            style="yellow",
        )

    console.print(
        Panel(
            _(
                "Missing skills cannot be extracted reliably from a "
                "free-text description by pure software — ESCO labels "
                "and natural prose don't line up well enough.\n\n"
                "For a complete gap analysis, re-import this opportunity "
                "with the AI parser:\n"
                "  career opportunity add --url <url> --parse"
            ),
            title=_("Why no missing skills?"),
            border_style="yellow",
        )
    )


def _short_code(code: str) -> str:
    """Trim an ESCO URI to its last segment for table display."""
    if not code:
        return ""
    if "/" in code:
        return code.rsplit("/", 1)[-1][:12]
    return code[:12]


def _print_suggest_stub() -> None:
    """Placeholder until the AI layer lands.

    The `--suggest` flag is documented as requiring an API key. The LLM
    adapter (core/llm.py) is not implemented yet, so we print a hint
    instead of failing silently.
    """
    console.print(
        _(
            "--suggest requires an LLM provider configured in config.yml. "
            "AI-assisted suggestions are not yet implemented in this build."
        ),
        style="yellow",
    )


def _resolve_opportunity(workspace, query: str) -> opp_core.Opportunity:
    """Resolve `query` to a single opportunity, prompting on ambiguity."""
    matches = opp_core.find_opportunity(workspace, query)
    if not matches:
        console.print(
            _("No opportunity matching '{q}'.").format(q=query),
            style="red",
        )
        raise typer.Exit(1)
    if len(matches) == 1:
        return matches[0]

    console.print(
        _("Multiple opportunities match '{q}':").format(q=query)
    )
    for n, opp in enumerate(matches, 1):
        console.print(f"  {n}. {opp.slug} — {opp.title}")
    choice = typer.prompt(_("Pick a number (or 0 to cancel)"), type=int)
    if choice < 1 or choice > len(matches):
        console.print(_("Cancelled."), style="yellow")
        raise typer.Exit(1)
    return matches[choice - 1]
