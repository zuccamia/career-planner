"""Workspace discovery and file I/O for career-planner.

All file reads/writes to the user's workspace go through this package.
Never use raw open() for workspace files elsewhere in the codebase.
"""

from __future__ import annotations

WORKSPACE_MARKER = "config.yml"
from .config import save_llm_config
from .editor import open_in_editor, resolve_editor
from .setup import WorkspaceExistsError, WORKSPACE_SUBDIRS, create_workspace, find_workspace, require_workspace
from .yaml_io import load_config, load_yaml_dict, save_yaml_dict

__all__ = [
    "WORKSPACE_MARKER",
    "WORKSPACE_SUBDIRS",
    "WorkspaceExistsError",
    "create_workspace",
    "find_workspace",
    "load_config",
    "load_yaml_dict",
    "open_in_editor",
    "require_workspace",
    "resolve_editor",
    "save_llm_config",
    "save_yaml_dict",
]