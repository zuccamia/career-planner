"""Skills inventory read/write for career-planner.

All access to ``skills/inventory.yml`` flows through this module.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import yaml

INVENTORY_RELPATH = Path("skills") / "inventory.yml"


def inventory_path(workspace: Path) -> Path:
    """Return the path to the inventory file inside a workspace."""
    return workspace / INVENTORY_RELPATH


def load_inventory(workspace: Path) -> list[dict[str, Any]]:
    """Read the skill entries from ``skills/inventory.yml``."""
    path = inventory_path(workspace)
    if not path.exists():
        return []
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    skills = raw.get("skills") or []
    return [dict(entry) for entry in skills]


def save_inventory(workspace: Path, skills: list[dict[str, Any]]) -> None:
    """Persist `skills` back to ``skills/inventory.yml``."""
    path = inventory_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"skills": list(skills)}
    path.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


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
) -> list[tuple[int, dict[str, Any]]]:
    """Return inventory entries that match `query` by name or ESCO code.

    Prefers exact matches; falls back to substring matches when nothing is
    exact. The returned tuples carry the entry's index for safe removal.
    """
    q = query.strip().lower()
    if not q:
        return []
    exact: list[tuple[int, dict[str, Any]]] = []
    partial: list[tuple[int, dict[str, Any]]] = []
    for idx, entry in enumerate(inventory):
        name = (entry.get("skill") or "").lower()
        code = (entry.get("esco_code") or "").lower()
        if q == name or (code and q == code):
            exact.append((idx, entry))
        elif q in name or (code and q in code):
            partial.append((idx, entry))
    return exact or partial
