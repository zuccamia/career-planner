from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from . import WORKSPACE_MARKER


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