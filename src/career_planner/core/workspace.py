"""Workspace discovery and file I/O for career-planner.

All file reads/writes to the user's workspace go through this module.
Never use raw open() for workspace files elsewhere in the codebase.
"""

from pathlib import Path

WORKSPACE_MARKER = "config.yml"


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
