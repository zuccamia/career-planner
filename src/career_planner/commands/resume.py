"""`career resume` — edit and render your resume."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import typer

from career_planner.commands._common import err_console, resolve_opportunity
from career_planner.core import brag as brag_core
from career_planner.core import llm as llm_core
from career_planner.core import resume as resume_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    require_workspace,
    resolve_editor,
)
from career_planner.i18n import _

# Cap on brag entries injected into the AI tailoring prompt. With ~500
# chars per entry body this stays under ~2.5k tokens even at full cap,
# while still surfacing the most recent ~year of accomplishments for
# typical users.
MAX_BRAG_ENTRIES = 20


def edit() -> None:
    """Open resume.yml in $EDITOR."""
    workspace = require_workspace()
    target = resume_core.resume_path(workspace)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.touch()

    editor = resolve_editor(load_config(workspace))
    try:
        rc = open_in_editor(target, editor)
    except FileNotFoundError:
        err_console.print(
            _(
                "Editor not found: '{ed}'. Set $EDITOR or the `editor` field "
                "in config.yml. Edit the file manually at:\n{path}"
            ).format(ed=editor, path=target),
            style="red",
        )
        raise typer.Exit(1) from None

    if rc != 0:
        err_console.print(
            _("Editor exited with status {n}.").format(n=rc),
            style="yellow",
        )
        raise typer.Exit(rc)


def render(opportunity: str | None = None) -> None:
    """Print the resume as markdown to stdout.

    With no opportunity, renders the master resume deterministically.
    With ``--for <opp>``, asks the configured LLM to tailor the resume
    to that opportunity. Exits 3 if no LLM provider is configured.
    """
    workspace = require_workspace()
    resume = resume_core.load_resume(workspace)
    if resume_core.is_empty(resume):
        err_console.print(
            _("Your resume is empty — run `career resume edit`."),
            style="red",
        )
        raise typer.Exit(1)

    if opportunity is None:
        typer.echo(resume_core.render_markdown(resume), nl=False)
        return

    opp = resolve_opportunity(workspace, opportunity)

    try:
        config = llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        err_console.print(
            _("`resume render --for` needs an LLM provider in config.yml: {err}").format(
                err=exc
            ),
            style="red",
        )
        raise typer.Exit(3) from None

    brag_entries, total_matched = _gather_relevant_brag_entries(workspace, resume)
    if brag_entries:
        if total_matched > len(brag_entries):
            err_console.print(
                _(
                    "Including {n} most recent of {total} matching brag entries."
                ).format(n=len(brag_entries), total=total_matched),
                style="dim",
            )
        else:
            err_console.print(
                _("Including {n} matching brag entries.").format(n=len(brag_entries)),
                style="dim",
            )

    with err_console.status(_("Tailoring with {model}…").format(model=config.model)):
        try:
            markdown = resume_core.render_tailored(
                resume, opp, config, brag_entries=brag_entries
            )
        except llm_core.LLMError as exc:
            err_console.print(
                _("Resume tailoring failed: {err}").format(err=exc),
                style="red",
            )
            raise typer.Exit(1) from None

    typer.echo(markdown, nl=False)


def _gather_relevant_brag_entries(
    workspace: Path, resume: dict[str, Any]
) -> tuple[tuple[brag_core.BragEntry, ...], int]:
    """Return brag entries whose tags overlap any experience entry's tags.

    Returns ``(entries, total_matched)`` where ``entries`` is capped at
    :data:`MAX_BRAG_ENTRIES` most recent and ``total_matched`` is the
    pre-cap count (so callers can surface "N of M" hints). Entries without
    a matching experience tag are dropped — they're not part of any
    experience's bullet pool.
    """
    experience_tags: set[str] = set()
    for exp in resume.get("experience") or []:
        if not isinstance(exp, dict):
            continue
        for tag in exp.get("tags") or []:
            if isinstance(tag, str) and tag.strip():
                experience_tags.add(tag.strip().lower())

    if not experience_tags:
        return (), 0

    matched = [
        entry
        for entry in brag_core.list_entries(workspace)
        if {t.lower() for t in entry.tags} & experience_tags
    ]
    # list_entries already sorts newest-first; take the cap from the top.
    return tuple(matched[:MAX_BRAG_ENTRIES]), len(matched)
