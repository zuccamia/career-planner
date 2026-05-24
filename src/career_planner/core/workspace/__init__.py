"""Workspace discovery and file I/O for career-planner.

All file reads/writes to the user's workspace go through this package.
Never use raw open() for workspace files elsewhere in the codebase.
"""

from __future__ import annotations

WORKSPACE_MARKER = "config.yml"
DEFAULT_EDITOR = "vim"

ENV_FILE_CONTENT = """
# AI Assistant Environment Variables
# Please update these variables based on your personal setup.

ANTHROPIC_API_KEY="your_key_here"
# OLLAMA_API_KEY="your_key_here"
# OPENAI_API_KEY="your_key_here"
# OPENROUTER_API_KEY="your_key_here"

FIRECRAWL_API_KEY="your_key_here"
"""

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

# Stable preferred order for the keys in the rendered ``llm:`` mapping.
# Anything in ``llm`` that isn't in this tuple is appended after, sorted.
_LLM_KEY_ORDER: tuple[str, ...] = (
    "provider",
    "base_url",
    "model",
    "api_key_env",
)

from .config import save_llm_config
from .editor import open_in_editor, resolve_editor
from .setup import WorkspaceExistsError, create_workspace, find_workspace, require_workspace
from .yaml_io import load_config, load_yaml_dict, save_yaml_dict

__all__ = [
    "BUNDLED_DATA_FILES",
    "DEFAULT_EDITOR",
    "ENV_FILE_CONTENT",
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