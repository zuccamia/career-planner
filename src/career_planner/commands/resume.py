"""`career resume` — edit and render your resume."""

from __future__ import annotations

import typer
from rich.console import Console

from career_planner.core import llm as llm_core
from career_planner.core import opportunities as opp_core
from career_planner.core import resume as resume_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    require_workspace,
    resolve_editor,
)
from career_planner.i18n import _

console = Console()
err_console = Console(stderr=True)


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

    opp = _resolve_opportunity(workspace, opportunity)

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

    with err_console.status(_("Tailoring with {model}…").format(model=config.model)):
        try:
            markdown = resume_core.render_tailored(resume, opp, config)
        except llm_core.LLMError as exc:
            err_console.print(
                _("Resume tailoring failed: {err}").format(err=exc),
                style="red",
            )
            raise typer.Exit(1) from None

    typer.echo(markdown, nl=False)


def _resolve_opportunity(workspace, query: str) -> opp_core.Opportunity:
    """Resolve `query` to a single opportunity, prompting on ambiguity."""
    matches = opp_core.find_opportunity(workspace, query)
    if not matches:
        err_console.print(
            _("No opportunity matching '{q}'.").format(q=query),
            style="red",
        )
        raise typer.Exit(1)
    if len(matches) == 1:
        return matches[0]

    err_console.print(_("Multiple opportunities match '{q}':").format(q=query))
    for n, opp in enumerate(matches, 1):
        err_console.print(f"  {n}. {opp.slug} — {opp.title}")
    choice = typer.prompt(_("Pick a number (or 0 to cancel)"), type=int)
    if choice < 1 or choice > len(matches):
        err_console.print(_("Cancelled."), style="yellow")
        raise typer.Exit(1)
    return matches[choice - 1]
