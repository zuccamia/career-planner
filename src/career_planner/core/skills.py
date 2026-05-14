"""Skills inventory read/write for career-planner.

All access to ``skills/inventory.yml`` flows through this module.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from career_planner.core.workspace import load_yaml_dict, save_yaml_dict

INVENTORY_RELPATH = Path("skills") / "inventory.yml"


def inventory_path(workspace: Path) -> Path:
    """Return the path to the inventory file inside a workspace."""
    return workspace / INVENTORY_RELPATH


def load_inventory(workspace: Path) -> list[dict[str, Any]]:
    """Read the skill entries from ``skills/inventory.yml``."""
    raw = load_yaml_dict(inventory_path(workspace))
    return [dict(entry) for entry in raw.get("skills") or []]


def save_inventory(workspace: Path, skills: list[dict[str, Any]]) -> None:
    """Persist `skills` back to ``skills/inventory.yml``."""
    save_yaml_dict(inventory_path(workspace), {"skills": list(skills)})


def make_entry(
    *,
    label: str,
    esco_code: str | None,
    rating: int,
    example: str,
    added: date | None = None,
) -> dict[str, Any]:
    """Build a canonical inventory entry dict."""
    entry: dict[str, Any] = {"skill": label}
    if esco_code:
        entry["esco_code"] = esco_code
    entry["rating"] = rating
    entry["example"] = example
    entry["added"] = (added or date.today()).isoformat()
    return entry


def is_duplicate(
    inventory: list[dict[str, Any]],
    label: str,
    esco_code: str | None,
) -> bool:
    """True if `label` or `esco_code` already appears in the inventory."""
    label_l = label.strip().lower()
    for entry in inventory:
        if esco_code and entry.get("esco_code") == esco_code:
            return True
        if (entry.get("skill") or "").strip().lower() == label_l:
            return True
    return False


def find_in_inventory(
    inventory: list[dict[str, Any]], query: str
) -> list[dict[str, Any]]:
    """Return inventory entries that match `query` by name or ESCO code.

    Prefers exact matches; falls back to substring matches when nothing is
    exact. ``is_duplicate`` keeps the inventory unique by (label, code),
    so callers can safely remove a returned entry with ``list.remove``.
    """
    q = query.strip().lower()
    if not q:
        return []
    exact: list[dict[str, Any]] = []
    partial: list[dict[str, Any]] = []
    for entry in inventory:
        name = (entry.get("skill") or "").lower()
        code = (entry.get("esco_code") or "").lower()
        if q == name or (code and q == code):
            exact.append(entry)
        elif q in name or (code and q in code):
            partial.append(entry)
    return exact or partial
