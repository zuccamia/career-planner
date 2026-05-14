"""`career man` — render the user manual in a pager."""

from __future__ import annotations

from importlib import resources
from pathlib import Path

import typer
from rich.markdown import Markdown

from career_planner.commands._common import console
from career_planner.i18n import _


def run(use_pager: bool = True) -> None:
    """Render the man page, in a pager when interactive."""
    try:
        content = _read_man_page()
    except FileNotFoundError:
        console.print(
            _("Manual page not found. Please reinstall career-planner."),
            style="red",
        )
        raise typer.Exit(1) from None

    markdown = Markdown(content)
    if use_pager and console.is_terminal:
        with console.pager(styles=True):
            console.print(markdown)
    else:
        console.print(markdown)


def _read_man_page() -> str:
    """Return the man page text.

    Looks first in the bundled package data (populated by the wheel build),
    then falls back to ``docs/man.md`` at the repo root for editable installs.
    """
    try:
        bundled = resources.files("career_planner").joinpath("data", "man.md")
        with resources.as_file(bundled) as path:
            if path.is_file():
                return path.read_text(encoding="utf-8")
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        pass

    repo_doc = Path(__file__).resolve().parents[3] / "docs" / "man.md"
    if repo_doc.is_file():
        return repo_doc.read_text(encoding="utf-8")

    raise FileNotFoundError("man.md not found in package data or repo docs/")
