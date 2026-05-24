"""`career resume` — edit and render your resume."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import typer

from career_planner.commands._common import (
    edit_file_in_editor,
    err_console,
    llm_status_or_exit,
    load_llm_config_or_exit,
    resolve_opportunity,
)
from career_planner.core import brag as brag_core
from career_planner.core import resume as resume_core
from career_planner.core.workspace import require_workspace
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
    edit_file_in_editor(workspace, target, must_edit=True, stderr=True)


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

    config = load_llm_config_or_exit(
        workspace,
        missing_message=_(
            "`resume render --for` needs an LLM provider in config.yml: {err}"
        ),
        output=err_console,
    )

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

    with llm_status_or_exit(
        status_message=_("Tailoring with {model}…").format(model=config.model),
        failure_message=_("Resume tailoring failed: {err}"),
        output=err_console,
    ):
        markdown = resume_core.render_tailored(
            resume, opp, config, brag_entries=brag_entries
        )

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
