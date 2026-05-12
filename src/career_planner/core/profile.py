"""Profile read/write and editor resolution for career-planner.

All access to ``profile.yml`` flows through this module.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any

import yaml

PROFILE_RELPATH = Path("profile.yml")
DEFAULT_EDITOR = "vim"


def profile_path(workspace: Path) -> Path:
    """Return the path to ``profile.yml`` inside a workspace."""
    return workspace / PROFILE_RELPATH


def load_profile(workspace: Path) -> dict[str, Any]:
    """Read the profile dict from ``profile.yml``. Empty dict if missing."""
    path = profile_path(workspace)
    if not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw if isinstance(raw, dict) else {}


def save_profile(workspace: Path, data: dict[str, Any]) -> None:
    """Persist `data` to ``profile.yml``."""
    path = profile_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


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
