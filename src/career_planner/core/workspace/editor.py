from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import DEFAULT_EDITOR


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