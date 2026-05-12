"""Workspace discovery and file I/O for career-planner.

All file reads/writes to the user's workspace go through this module.
Never use raw open() for workspace files elsewhere in the codebase.
"""

from __future__ import annotations

import shutil
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

WORKSPACE_MARKER = "config.yml"

# Subdirectories created by `career init`. Order doesn't matter — each is
# created with mkdir(parents=True). data/coaching is populated from bundled
# templates; the rest start empty.
WORKSPACE_SUBDIRS: tuple[str, ...] = (
    "skills",
    "brag",
    "resumes",
    "opportunities",
    "assessments",
    "conversations",
    "data/coaching",
    "data/cache",
    "locale",
)

# Bundled taxonomy/transition data files. Copied into the workspace's data/
# directory if present in the package. These ship with the maintainer-prepared
# release; if a file is missing during early development, it is skipped.
BUNDLED_DATA_FILES: tuple[str, ...] = (
    "esco-skills.yml",
    "esco-occupations.yml",
    "esco-occupation-skills.yml",
    "esco-skill-hierarchy.yml",
    "transitions.yml",
    "crosswalk.csv",
)


class WorkspaceExistsError(Exception):
    """Raised when a workspace already exists at the target path."""

    def __init__(self, path: Path) -> None:
        super().__init__(str(path))
        self.path = path


def find_workspace(start: Path | None = None) -> Path | None:
    """Walk up from `start` (default: cwd) to find a workspace root.

    A workspace root is a directory containing config.yml.
    Returns the workspace Path, or None if not found.
    """
    current = start or Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / WORKSPACE_MARKER).exists():
            return parent
    return None


def require_workspace(start: Path | None = None) -> Path:
    """Like find_workspace, but raises SystemExit(2) if not found."""
    ws = find_workspace(start)
    if ws is None:
        raise SystemExit(2)
    return ws


def load_config(workspace: Path) -> dict[str, Any]:
    """Read ``config.yml`` from a workspace. Returns an empty dict if missing."""
    path = workspace / WORKSPACE_MARKER
    if not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw if isinstance(raw, dict) else {}


def create_workspace(path: Path, language: str = "en") -> Path:
    """Create a new workspace at `path`.

    Creates the directory tree, writes starter templates (config.yml,
    profile.yml, criteria.yml, skills/inventory.yml) and copies bundled
    coaching configuration into data/coaching/. Bundled ESCO/JobHop data
    files are copied into data/ when available.

    Raises WorkspaceExistsError if a config.yml already exists at `path`.
    """
    path = path.expanduser().resolve()
    if (path / WORKSPACE_MARKER).exists():
        raise WorkspaceExistsError(path)

    path.mkdir(parents=True, exist_ok=True)
    for sub in WORKSPACE_SUBDIRS:
        (path / sub).mkdir(parents=True, exist_ok=True)

    _write_config(path / "config.yml", language=language)
    _copy_template("profile.yml", path / "profile.yml")
    _copy_template("criteria.yml", path / "criteria.yml")
    _copy_template("skills_inventory.yml", path / "skills" / "inventory.yml")

    _copy_bundled("coaching/system-prompt.md", path / "data" / "coaching" / "system-prompt.md")
    _copy_bundled("coaching/policies.md", path / "data" / "coaching" / "policies.md")

    for filename in BUNDLED_DATA_FILES:
        _copy_bundled_if_exists(filename, path / "data" / filename)

    return path


def _write_config(target: Path, language: str) -> None:
    """Write config.yml from the template, substituting the language field."""
    template = _read_template("config.yml")
    contents = template.replace("language: en", f"language: {language}", 1)
    target.write_text(contents, encoding="utf-8")


def _copy_template(name: str, target: Path) -> None:
    """Copy a starter template from src/career_planner/data/templates/ to target."""
    target.write_text(_read_template(name), encoding="utf-8")


def _read_template(name: str) -> str:
    return (
        resources.files("career_planner")
        .joinpath("data", "templates", name)
        .read_text(encoding="utf-8")
    )


def _copy_bundled(relative: str, target: Path) -> None:
    """Copy a bundled file (rooted at career_planner/data) to target."""
    src = resources.files("career_planner").joinpath("data", relative)
    target.write_bytes(src.read_bytes())


def _copy_bundled_if_exists(relative: str, target: Path) -> None:
    """Copy a bundled file if it exists in the package data directory.

    Silently skips files that haven't been generated yet (e.g. taxonomy data
    that's prepared by maintainer scripts).
    """
    src = resources.files("career_planner").joinpath("data", relative)
    try:
        with resources.as_file(src) as src_path:
            if src_path.is_file():
                shutil.copy2(src_path, target)
    except (FileNotFoundError, ModuleNotFoundError):
        return
