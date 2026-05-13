"""Profile read/write for career-planner.

All access to ``profile.yml`` flows through this module.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

PROFILE_RELPATH = Path("profile.yml")


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
