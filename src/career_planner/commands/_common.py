"""Shared helpers for ``career_planner.commands`` modules.

Every command module imports ``console`` (stdout) and ``err_console``
(stderr) from here instead of instantiating its own. Stdout is reserved
for the command's "data" output — markdown from ``resume render``,
tables from ``status`` / ``brag list``, etc. — so it pipes cleanly.
Status messages, prompts, and errors go through ``err_console``.

``fail`` is the standard "print an error, exit non-zero" pattern.
``disambiguate`` is the standard "resolve a query to one of N matches"
pattern; ``resolve_opportunity`` wraps it for the common opportunity case.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, NoReturn, TypeVar

import typer
from rich.console import Console

from career_planner.core import llm as llm_core
from career_planner.core import opportunity as opp_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    resolve_editor,
)
from career_planner.i18n import _

console = Console()
err_console = Console(stderr=True)

T = TypeVar("T")


def fail(message: str, *, code: int = 1, style: str = "red") -> NoReturn:
    """Print `message` to stderr in `style` and raise ``typer.Exit(code)``."""
    err_console.print(message, style=style)
    raise typer.Exit(code)


def load_llm_config_or_exit(
    workspace: Path,
    *,
    missing_message: str,
    output: Console | None = None,
    exit_code: int = 3,
) -> llm_core.LLMConfig:
    """Load the workspace LLM config or print a friendly error and exit.

    ``missing_message`` should contain an ``{err}`` placeholder for the
    underlying :class:`career_planner.core.llm.LLMConfigError` message.
    """
    output = output or err_console
    try:
        return llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        output.print(missing_message.format(err=exc), style="red")
        raise typer.Exit(exit_code) from None


@contextmanager
def llm_status_or_exit(
    *,
    status_message: str,
    failure_message: str,
    output: Console | None = None,
    exit_code: int = 1,
    handled_errors: tuple[type[BaseException], ...] = (llm_core.LLMError,),
) -> Iterator[None]:
    """Wrap an LLM-backed block with status output and consistent error handling."""
    output = output or err_console
    with output.status(status_message):
        try:
            yield
        except handled_errors as exc:
            output.print(failure_message.format(err=exc), style="red")
            raise typer.Exit(exit_code) from None


def disambiguate(
    matches: list[T],
    *,
    query: str,
    describe: Callable[[T], str],
    not_found: str | None = None,
    multiple: str | None = None,
) -> T:
    """Resolve `query` to a single item from `matches`.

    Exits 1 when there are no matches. Returns the single match when there
    is exactly one. Prompts the user to pick when there are multiple.
    The disambiguation UI is written to stderr so commands like
    ``resume render --for`` can pipe their stdout output safely.
    """
    if not matches:
        fail(not_found or _("No match for '{q}'.").format(q=query))
    if len(matches) == 1:
        return matches[0]

    err_console.print(
        multiple or _("Multiple matches for '{q}':").format(q=query)
    )
    for n, item in enumerate(matches, 1):
        err_console.print(f"  {n}. {describe(item)}")
    choice = typer.prompt(_("Pick a number (or 0 to cancel)"), type=int)
    if choice < 1 or choice > len(matches):
        fail(_("Cancelled."), style="yellow")
    return matches[choice - 1]


def resolve_opportunity(workspace, query: str) -> opp_core.Opportunity:
    """Resolve `query` to one tracked opportunity. Prompts on ambiguity."""
    return disambiguate(
        opp_core.find_opportunity(workspace, query),
        query=query,
        describe=lambda o: f"{o.slug} — {o.title}",
        not_found=_("No opportunity matching '{q}'.").format(q=query),
        multiple=_("Multiple opportunities match '{q}':").format(q=query),
    )


def edit_file_in_editor(
    workspace: Path,
    target: Path,
    *,
    must_edit: bool = False,
    exit_on_nonzero: bool = True,
    stderr: bool = False,
) -> None:
    """Open `target` in the user's $EDITOR. Used by every `*-edit` command.

    Resolves the editor from config + environment, runs it, and reports
    failures consistently. The three knobs handle the variations between
    callers:

    * ``must_edit`` — when True, a missing editor binary raises
      ``typer.Exit(1)`` with a hint about ``$EDITOR`` and the ``editor``
      config field. Use for commands whose whole purpose is editing
      (``criteria edit``, ``resume edit``). When False, missing editor is
      a warning that returns — used when the file is already on disk and
      the editor is a convenience (``brag add``, ``opportunity add``).
    * ``exit_on_nonzero`` — when True (default), a non-zero editor exit
      code propagates via ``typer.Exit(rc)``. When False, the code is
      reported as a warning and the command continues.
    * ``stderr`` — when True, all messages go to stderr so stdout stays
      clean for piping (used by ``resume edit``, which is paired with
      ``resume render``).
    """
    output = err_console if stderr else console
    editor = resolve_editor(load_config(workspace))
    try:
        rc = open_in_editor(target, editor)
    except FileNotFoundError:
        if must_edit:
            output.print(
                _(
                    "Editor not found: '{ed}'. Set $EDITOR or the `editor` "
                    "field in config.yml. Edit the file manually at:\n{path}"
                ).format(ed=editor, path=target),
                style="red",
            )
            raise typer.Exit(1) from None
        output.print(
            _(
                "Editor not found: '{ed}'. Edit the file manually at:\n{path}"
            ).format(ed=editor, path=target),
            style="yellow",
        )
        return

    if rc != 0:
        output.print(
            _("Editor exited with status {n}.").format(n=rc),
            style="yellow",
        )
        if exit_on_nonzero:
            raise typer.Exit(rc)


def short_code(code: Any) -> str:
    """Render an ESCO URI as a short, table-friendly identifier."""
    if not code:
        return ""
    s = str(code)
    if "/" in s:
        return s.rsplit("/", 1)[-1][:12]
    return s[:12]
