"""Tag inventory across the workspace.

Brag entries and ``resume.yml`` experience entries both carry a
``tags:`` field. The shared tag is how ``resume render --for`` decides
which brag bullets to pull into the LLM prompt: a brag entry's tags
link it to the experience it belongs to.

This module is the single source of truth for "what tags exist in this
workspace right now." Tags are normalized to lowercase here — the
brag-pool matching is also case-insensitive, so the canonical form is
lowercase end-to-end.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from career_planner.core import brag as brag_core
from career_planner.core import resume as resume_core


@dataclass(frozen=True)
class TagUsage:
    """How a single tag is used across the workspace."""

    tag: str
    brag_count: int
    experience_count: int

    @property
    def total(self) -> int:
        return self.brag_count + self.experience_count


def collect_tags(workspace: Path) -> list[TagUsage]:
    """Return all tags across ``brag/`` and ``resume.yml``, sorted by usage.

    Sort order: total usage descending, then alphabetical for stable
    ordering when counts tie.
    """
    brag_counts = _count_brag_tags(workspace)
    experience_counts = _count_experience_tags(workspace)

    all_tags = set(brag_counts) | set(experience_counts)
    usages = [
        TagUsage(
            tag=tag,
            brag_count=brag_counts.get(tag, 0),
            experience_count=experience_counts.get(tag, 0),
        )
        for tag in all_tags
    ]
    usages.sort(key=lambda u: (-u.total, u.tag))
    return usages


def normalize(value: Any) -> str:
    """Return the canonical (lowercase, trimmed) form of `value`. ``""`` if invalid."""
    if not isinstance(value, str):
        return ""
    return value.strip().lower()


def _count_brag_tags(workspace: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in brag_core.list_entries(workspace):
        for tag in entry.tags:
            key = normalize(tag)
            if key:
                counts[key] = counts.get(key, 0) + 1
    return counts


def _count_experience_tags(workspace: Path) -> dict[str, int]:
    counts: dict[str, int] = {}
    resume = resume_core.load_resume(workspace)
    for exp in resume.get("experience") or []:
        if not isinstance(exp, dict):
            continue
        for tag in exp.get("tags") or []:
            key = normalize(tag)
            if key:
                counts[key] = counts.get(key, 0) + 1
    return counts
