"""`career brag` — record and review career achievements (XYZ format)."""

from __future__ import annotations

from datetime import date

import typer
from rich.markdown import Markdown
from rich.table import Table

from career_planner.commands._common import console, disambiguate
from career_planner.core import brag as brag_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    require_workspace,
    resolve_editor,
)
from career_planner.i18n import _


def add(title: str | None = None, date_str: str | None = None) -> None:
    """Create a brag entry from the template and open it in $EDITOR."""
    workspace = require_workspace()

    entry_date = _parse_date(date_str) if date_str else date.today()
    if entry_date is None:
        console.print(
            _("Invalid date '{d}' (expected YYYY-MM-DD).").format(d=date_str),
            style="red",
        )
        raise typer.Exit(1)

    if not title or not title.strip():
        title = typer.prompt(_("Title for this brag entry (short, descriptive)"))
    title = title.strip()
    if not title:
        console.print(_("Title cannot be empty."), style="red")
        raise typer.Exit(1)

    path = brag_core.create_entry(workspace, title=title, entry_date=entry_date)

    editor = resolve_editor(load_config(workspace))
    try:
        rc = open_in_editor(path, editor)
    except FileNotFoundError:
        console.print(
            _(
                "Editor not found: '{ed}'. Created the entry at {path}; edit "
                "it manually."
            ).format(ed=editor, path=path),
            style="yellow",
        )
        return

    if rc != 0:
        console.print(
            _("Editor exited with status {n}.").format(n=rc),
            style="yellow",
        )
        raise typer.Exit(rc)

    console.print(
        _("Saved brag entry at {path}.").format(path=path),
        style="green",
    )


def list_entries(last: int = 10, tag: str | None = None) -> None:
    """Display brag entries as a Rich table, most recent first."""
    workspace = require_workspace()
    entries = brag_core.list_entries(workspace)

    if tag:
        needle = tag.strip().lower()
        entries = [e for e in entries if any(t.lower() == needle for t in e.tags)]

    if not entries:
        console.print(
            _("No brag entries yet — run `career brag add`."),
            style="yellow",
        )
        return

    rows = entries[: max(0, last)] if last else entries

    table = Table(title=_("Brag entries"))
    table.add_column(_("Date"), style="cyan")
    table.add_column(_("Title"))
    table.add_column(_("Project"))
    table.add_column(_("Tags"), style="dim")

    for entry in rows:
        table.add_row(
            entry.date.isoformat() if entry.date else "—",
            entry.title,
            entry.project or "—",
            ", ".join(entry.tags) or "—",
        )
    console.print(table)

    if last and len(entries) > last:
        console.print(
            _("(showing {n} of {total} entries)").format(n=len(rows), total=len(entries)),
            style="dim",
        )


def show(entry: str) -> None:
    """Render a brag entry's markdown to the console."""
    workspace = require_workspace()
    target = disambiguate(
        brag_core.find_entries(workspace, entry),
        query=entry,
        describe=lambda e: e.slug,
        not_found=_("No brag entry matching '{q}'.").format(q=entry),
        multiple=_("Multiple brag entries match '{q}':").format(q=entry),
    )
    text = target.path.read_text(encoding="utf-8")
    console.print(Markdown(text))


def _parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None
