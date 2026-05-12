"""`career about` / `career --version` — show version and data attribution."""

from __future__ import annotations

import typer

from career_planner import __version__
from career_planner.i18n import _

DESCRIPTION = _("A local-first, CLI-based personal career planning tool.")
DATA_ATTRIBUTION = (
    "Data: ESCO classification v1.2.1 (European Commission), "
    "O*NET 29.0 (USDOL/ETA)"
)
NOTICES_POINTER = "See THIRD_PARTY_NOTICES.md for full attribution."


def run() -> None:
    """Print project name, version, description, and data attribution."""
    typer.echo(f"career-planner {__version__}")
    typer.echo(DESCRIPTION)
    typer.echo("")
    typer.echo(DATA_ATTRIBUTION)
    typer.echo(NOTICES_POINTER)
