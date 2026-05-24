from __future__ import annotations

import shutil
from importlib import resources
from pathlib import Path

from . import BUNDLED_DATA_FILES, ENV_FILE_CONTENT, WORKSPACE_MARKER, WORKSPACE_SUBDIRS


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

    _create_workspace_directories(path)
    _seed_workspace_templates(path, language=language)
    _copy_workspace_bundles(path)
    env_path = _write_env_file(path)

    print(f"✅ Workspace '{path.name}' created successfully.")
    print(f"👉 Remember to configure your API keys in {env_path}")

    return path


def _create_workspace_directories(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for sub in WORKSPACE_SUBDIRS:
        (path / sub).mkdir(parents=True, exist_ok=True)


def _seed_workspace_templates(path: Path, *, language: str) -> None:
    _write_config(path / WORKSPACE_MARKER, language=language)
    _copy_template("criteria.yml", path / "criteria.yml")
    _copy_template("resume.yml", path / "resume.yml")
    _copy_template("skills_inventory.yml", path / "skills" / "inventory.yml")


def _copy_workspace_bundles(path: Path) -> None:
    coaching_dir = path / "data" / "coaching"
    _copy_bundled(
        "coaching/system-prompt.md",
        coaching_dir / "system-prompt.md",
    )
    _copy_bundled(
        "coaching/policies.md",
        coaching_dir / "policies.md",
    )

    data_dir = path / "data"
    for filename in BUNDLED_DATA_FILES:
        _copy_bundled_if_exists(filename, data_dir / filename)


def _write_env_file(path: Path) -> Path:
    env_path = path / ".env"
    env_path.write_text(ENV_FILE_CONTENT.strip())
    return env_path


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