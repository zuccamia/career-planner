"""Workspace discovery and file I/O for career-planner.

All file reads/writes to the user's workspace go through this module.
Never use raw open() for workspace files elsewhere in the codebase.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

WORKSPACE_MARKER = "config.yml"
DEFAULT_EDITOR = "vim"

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


def load_yaml_dict(path: Path) -> dict[str, Any]:
    """Read `path` as a YAML mapping. Returns ``{}`` when missing or malformed.

    Used by every "read a YAML config" call in the codebase (config.yml,
    criteria.yml, resume.yml, skills/inventory.yml). Centralizing means
    one consistent set of fallbacks: missing file → empty dict, malformed
    top-level (a list, scalar, etc.) → empty dict.
    """
    if not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw if isinstance(raw, dict) else {}


def save_yaml_dict(path: Path, data: dict[str, Any]) -> None:
    """Write `data` as YAML to `path`, creating parent directories.

    Always serialized with ``sort_keys=False, allow_unicode=True`` so the
    field order matches the in-memory dict (matters for human-edited
    files) and non-ASCII content round-trips cleanly.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def load_config(workspace: Path) -> dict[str, Any]:
    """Read ``config.yml`` from a workspace. Returns an empty dict if missing."""
    return load_yaml_dict(workspace / WORKSPACE_MARKER)


def resolve_editor(config: dict[str, Any] | None = None) -> str:
    """Resolve the editor command from config or environment.

    Order of precedence:
      1. ``config['editor']`` if set and not the literal ``$EDITOR`` placeholder
      2. ``$EDITOR`` environment variable
      3. fallback: ``vim``
    """
    raw = (config or {}).get("editor")
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped and stripped != "$EDITOR":
            return stripped
    return os.environ.get("EDITOR") or DEFAULT_EDITOR


def open_in_editor(file_path: Path, editor: str) -> int:
    """Run ``editor file_path`` synchronously and return the exit code.

    Raises ``FileNotFoundError`` if the editor binary can't be located on PATH.
    """
    parts = shlex.split(editor)
    if not parts or shutil.which(parts[0]) is None:
        raise FileNotFoundError(editor)
    return subprocess.run([*parts, str(file_path)]).returncode


def save_llm_config(workspace: Path, llm: dict[str, Any]) -> None:
    """Replace (or append) the ``llm:`` mapping in ``config.yml``.

    Edits the file as text rather than re-serializing the whole document,
    so comments and other top-level sections (``language``, ``data``,
    ``mcp``, ``editor``, etc.) are preserved.

    ``llm`` is rendered in stable key order; values are passed through
    ``yaml.safe_dump`` so URLs, model IDs with colons, etc. are quoted
    correctly when needed.
    """
    path = workspace / WORKSPACE_MARKER
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(_replace_llm_block(text, llm), encoding="utf-8")


# Stable preferred order for the keys in the rendered ``llm:`` mapping.
# Anything in ``llm`` that isn't in this tuple is appended after, sorted.
_LLM_KEY_ORDER: tuple[str, ...] = (
    "provider",
    "base_url",
    "model",
    "api_key_env",
)


def _replace_llm_block(text: str, llm: dict[str, Any]) -> str:
    """Return ``text`` with its ``llm:`` mapping replaced or appended."""
    block = _render_llm_block(llm)
    lines = text.splitlines()

    start = None
    for i, line in enumerate(lines):
        # Top-level ``llm:`` line — no leading whitespace, ``llm:`` at column 0.
        if line.rstrip().startswith("llm:") and not line[:1].isspace():
            start = i
            break

    if start is None:
        prefix = text.rstrip("\n")
        if prefix:
            prefix += "\n\n"
        return prefix + block + "\n"

    # End of the block is the first subsequent line that starts in column 0
    # and is neither blank nor a comment — i.e. the next top-level YAML key.
    end = len(lines)
    for j in range(start + 1, len(lines)):
        line = lines[j]
        if not line.strip():
            continue
        if line[:1].isspace():
            continue
        if line.lstrip().startswith("#"):
            # A comment in column 0 belongs to the *following* section, so
            # stop here and keep that comment in place.
            end = j
            break
        end = j
        break

    # Trim trailing blank lines that were inside the old block, so the
    # spacing after the replacement matches what was there before.
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1

    new_lines = lines[:start] + block.splitlines() + lines[end:]
    result = "\n".join(new_lines)
    if not result.endswith("\n"):
        result += "\n"
    return result


def _render_llm_block(llm: dict[str, Any]) -> str:
    """Render an ``llm`` config dict as a YAML mapping rooted at ``llm:``."""
    ordered: dict[str, Any] = {}
    for key in _LLM_KEY_ORDER:
        if key in llm and llm[key] not in (None, ""):
            ordered[key] = llm[key]
    for key in sorted(llm):
        if key in _LLM_KEY_ORDER:
            continue
        if llm[key] in (None, ""):
            continue
        ordered[key] = llm[key]

    rendered = yaml.safe_dump(
        {"llm": ordered}, default_flow_style=False, sort_keys=False
    )
    return rendered.rstrip("\n")


def create_workspace(path: Path, language: str = "en") -> Path:
    """Create a new workspace at `path`.

    Creates the directory tree, writes starter templates (config.yml,
    criteria.yml, resume.yml, skills/inventory.yml) and copies bundled
    coaching configuration into data/coaching/. Bundled ESCO data files
    are copied into data/ when available.

    Raises WorkspaceExistsError if a config.yml already exists at `path`.
    """
    path = path.expanduser().resolve()
    if (path / WORKSPACE_MARKER).exists():
        raise WorkspaceExistsError(path)

    path.mkdir(parents=True, exist_ok=True)
    for sub in WORKSPACE_SUBDIRS:
        (path / sub).mkdir(parents=True, exist_ok=True)

    _write_config(path / "config.yml", language=language)
    _copy_template("criteria.yml", path / "criteria.yml")
    _copy_template("resume.yml", path / "resume.yml")
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
