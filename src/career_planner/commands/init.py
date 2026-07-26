"""`career init` — initialize a new career workspace."""

from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel

from career_planner.core.workspace import WorkspaceExistsError, create_workspace
from career_planner.i18n import _

SUPPORTED_LANGUAGES = ("en", "vi")

console = Console()


def run(directory: str = ".", language: str = "en") -> None:
    """Create a new workspace at `directory` and print a summary."""
    if language not in SUPPORTED_LANGUAGES:
        console.print(
            _("Unsupported language: {lang}. Supported: {choices}.").format(
                lang=language, choices=", ".join(SUPPORTED_LANGUAGES)
            ),
            style="red",
        )
        raise typer.Exit(1)

    target = Path(directory).expanduser().resolve()

    try:
        workspace = create_workspace(target, language=language)
    except WorkspaceExistsError as exc:
        console.print(
            Panel(
                _("A workspace already exists at:\n{path}").format(path=exc.path),
                title=_("Workspace exists"),
                border_style="red",
            )
        )
        raise typer.Exit(1) from None

    _print_success(workspace)


def _print_success(workspace: Path) -> None:
    lines = [
        _("Workspace created at:"),
        f"  {workspace}",
        "",
        _("Next steps:"),
        "  career profile edit",
        "  career criteria edit",
        "  career skills browse",
    ]
    console.print(
        Panel(
            "\n".join(lines),
            title=_("Career workspace ready"),
            border_style="green",
        )
    )
