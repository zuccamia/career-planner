"""Brag entry file I/O for career-planner.

Brag entries live as Markdown files with a YAML frontmatter block under
``brag/`` in the workspace. Each entry follows the XYZ format
("Accomplished X as measured by Y by doing Z") and is named
``YYYY-MM-DD-{slug}.md``.

The ``tags:`` frontmatter field links entries to ``resume.yml`` experience
entries' ``tags:`` — used by ``resume render --for`` to pull matching brag
content into the bullet pool.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

from career_planner.core import opportunities as opp_core

BRAG_RELPATH = Path("brag")
TEMPLATE_NAME = "brag_entry.md"

_FILENAME_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


@dataclass(frozen=True)
class BragEntry:
    """A single brag entry parsed from a Markdown file."""

    path: Path
    slug: str          # filename without ``.md``
    date: date | None
    project: str
    tags: tuple[str, ...]
    body: str

    @property
    def title(self) -> str:
        """Friendly title derived from the slug (date prefix stripped)."""
        match = _FILENAME_DATE_RE.match(self.slug)
        if match:
            tail = self.slug[match.end():].lstrip("-")
        else:
            tail = self.slug
        return tail.replace("-", " ").strip() or self.slug


# --- file I/O ---


def brag_dir(workspace: Path) -> Path:
    """Return the path to the ``brag/`` directory inside a workspace."""
    return workspace / BRAG_RELPATH


def brag_entry_path(workspace: Path, slug: str) -> Path:
    """Return the path to a brag entry by slug (no extension)."""
    return brag_dir(workspace) / f"{slug}.md"


def list_entries(workspace: Path) -> list[BragEntry]:
    """Return all brag entries in the workspace, sorted by date desc.

    Entries with no parseable date sort to the end (alphabetical by slug).
    """
    folder = brag_dir(workspace)
    if not folder.exists():
        return []
    entries: list[BragEntry] = []
    for path in sorted(folder.glob("*.md")):
        entry = _read_entry(path)
        if entry is not None:
            entries.append(entry)
    entries.sort(
        key=lambda e: (e.date is None, -(e.date.toordinal() if e.date else 0), e.slug)
    )
    return entries


def load_entry(workspace: Path, slug: str) -> BragEntry | None:
    """Load a single brag entry by slug. Returns None if missing."""
    path = brag_entry_path(workspace, slug)
    if not path.exists():
        return None
    return _read_entry(path)


def find_entries(workspace: Path, query: str) -> list[BragEntry]:
    """Substring-match brag entries by slug or derived title.

    Exact slug match wins; otherwise returns all entries whose slug or
    title contains `query` (case-insensitive).
    """
    needle = query.strip().lower()
    if not needle:
        return []
    entries = list_entries(workspace)
    exact = [e for e in entries if e.slug.lower() == needle]
    if exact:
        return exact
    return [
        e for e in entries
        if needle in e.slug.lower() or needle in e.title.lower()
    ]


def create_entry(
    workspace: Path,
    *,
    title: str,
    entry_date: date | None = None,
) -> Path:
    """Create a new brag entry from the template and return its path.

    The slug is ``YYYY-MM-DD-{slugified title}``. If a file with that name
    already exists, ``-2``, ``-3``, … are appended until a free slot is
    found.
    """
    folder = brag_dir(workspace)
    folder.mkdir(parents=True, exist_ok=True)

    entry_date = entry_date or date.today()
    base_slug = f"{entry_date.isoformat()}-{opp_core.slugify(title)}"
    slug = _unique_slug(folder, base_slug)
    target = folder / f"{slug}.md"

    template = (
        resources.files("career_planner")
        .joinpath("data", "templates", TEMPLATE_NAME)
        .read_text(encoding="utf-8")
    )
    target.write_text(
        template.replace("{date}", entry_date.isoformat()),
        encoding="utf-8",
    )
    return target


# --- internals ---


def _read_entry(path: Path) -> BragEntry | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    front, body = opp_core.parse_markdown(text)
    parsed_date = _coerce_date(front.get("date")) or _filename_date(path)
    return BragEntry(
        path=path,
        slug=path.stem,
        date=parsed_date,
        project=str(front.get("project") or "").strip(),
        tags=_coerce_tags(front.get("tags")),
        body=body,
    )


def _unique_slug(folder: Path, slug: str) -> str:
    base = slug or "brag"
    candidate = base
    n = 2
    while (folder / f"{candidate}.md").exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def _filename_date(path: Path) -> date | None:
    match = _FILENAME_DATE_RE.match(path.name)
    if not match:
        return None
    return _coerce_date(
        f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    )


def _coerce_date(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def _coerce_tags(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(
        str(item).strip()
        for item in value
        if str(item).strip()
    )
