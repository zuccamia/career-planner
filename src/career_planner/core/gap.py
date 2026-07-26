"""Skill gap analysis for career-planner.

Compares a user's skills inventory (``skills/inventory.yml``) against the
``required_skills`` field of an opportunity. Pure software — no LLM.

Each entry in an opportunity's ``required_skills`` list is parsed into a
:class:`Requirement`. Two shapes are supported:

* A bare string — either an ESCO URI (``http://data.europa.eu/esco/skill/...``)
  or a free-text label. Free-text labels are resolved against the bundled
  taxonomy when there is a confident match.
* A mapping like ``{skill: "Python programming", min_rating: 4}``.

A :class:`Requirement` then either matches an inventory entry (by ESCO URI,
exact label, or alt-label) or doesn't. A match with ``rating < min_rating``
becomes a *partial* match; everything else is *matched* or *missing*.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from career_planner.core import taxonomy

STATUS_MATCHED = "matched"
STATUS_PARTIAL = "partial"
STATUS_MISSING = "missing"

# Confidence floor for promoting a free-text requirement label into a
# canonical ESCO skill. The threshold mirrors the auto-accept rule in
# ``commands/skills.py``: a top score >= 0.85 with a 0.10-point lead over
# the runner-up wins; anything below is left as free text.
_REQUIREMENT_AUTO_THRESHOLD = 0.85
_REQUIREMENT_TIE_BREAK = 0.10


@dataclass(frozen=True)
class Requirement:
    """A single skill requirement parsed from an opportunity."""

    label: str
    esco_code: str = ""
    min_rating: int | None = None

    @property
    def has_threshold(self) -> bool:
        return self.min_rating is not None


@dataclass(frozen=True)
class GapMatch:
    """The result of comparing one requirement against the inventory."""

    requirement: Requirement
    status: str
    inventory_entry: dict[str, Any] | None = None

    @property
    def rating(self) -> int | None:
        if not self.inventory_entry:
            return None
        try:
            return int(self.inventory_entry.get("rating"))
        except (TypeError, ValueError):
            return None

    @property
    def example(self) -> str:
        if not self.inventory_entry:
            return ""
        return str(self.inventory_entry.get("example") or "")


@dataclass(frozen=True)
class GapAnalysis:
    """Outcome of a full inventory-vs-requirements comparison."""

    matches: tuple[GapMatch, ...]

    @property
    def matched(self) -> tuple[GapMatch, ...]:
        return tuple(m for m in self.matches if m.status == STATUS_MATCHED)

    @property
    def partial(self) -> tuple[GapMatch, ...]:
        return tuple(m for m in self.matches if m.status == STATUS_PARTIAL)

    @property
    def missing(self) -> tuple[GapMatch, ...]:
        return tuple(m for m in self.matches if m.status == STATUS_MISSING)

    @property
    def coverage(self) -> float:
        """Fraction of requirements fully met, in ``[0, 1]``."""
        total = len(self.matches)
        if not total:
            return 0.0
        return len(self.matched) / total


def parse_requirements(raw: Any) -> list[Requirement]:
    """Parse an opportunity's ``required_skills`` field into Requirements.

    Accepts a list whose entries are strings (URIs or labels) or mappings.
    Empty / non-list inputs return an empty list. Free-text labels are
    resolved to ESCO skills when the top match is unambiguous; otherwise
    the original label is preserved verbatim.
    """
    if not isinstance(raw, list):
        return []

    out: list[Requirement] = []
    for entry in raw:
        req = _parse_one(entry)
        if req is not None:
            out.append(req)
    return out


def _parse_one(entry: Any) -> Requirement | None:
    if isinstance(entry, str):
        text = entry.strip()
        if not text:
            return None
        return _from_string(text, min_rating=None)

    if isinstance(entry, dict):
        label = str(entry.get("skill") or entry.get("label") or "").strip()
        code = str(entry.get("esco_code") or entry.get("uri") or "").strip()
        min_rating = _coerce_rating(
            entry.get("min_rating") if "min_rating" in entry else entry.get("rating")
        )
        if code:
            skill = taxonomy.find_skill_by_uri(code)
            return Requirement(
                label=label or (skill.preferred_label if skill else code),
                esco_code=code,
                min_rating=min_rating,
            )
        if label:
            return _from_string(label, min_rating=min_rating)
    return None


def _from_string(text: str, *, min_rating: int | None) -> Requirement:
    """Build a Requirement from a free-form string.

    A literal URI is kept as-is and its ESCO preferred label is used for
    display. Free text is fuzzy-matched against ESCO: a confident hit
    attaches the URI so the inventory matcher can find a synonym match,
    but the user-provided text remains the display label (so the gap
    table doesn't surprise the user with a renamed skill).
    """
    if text.startswith("http://") or text.startswith("https://"):
        skill = taxonomy.find_skill_by_uri(text)
        return Requirement(
            label=skill.preferred_label if skill else text,
            esco_code=text,
            min_rating=min_rating,
        )

    matches = taxonomy.find_skill_matches(text)
    if matches:
        top, top_score = matches[0]
        second = matches[1][1] if len(matches) > 1 else 0.0
        if top_score >= 0.999 or (
            top_score >= _REQUIREMENT_AUTO_THRESHOLD
            and (top_score - second) >= _REQUIREMENT_TIE_BREAK
        ):
            return Requirement(
                label=text,
                esco_code=top.uri,
                min_rating=min_rating,
            )
    return Requirement(label=text, esco_code="", min_rating=min_rating)


def _coerce_rating(value: Any) -> int | None:
    """Clamp a rating to ``1..5``. Non-numeric or out-of-range → None."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if 1 <= n <= 5:
        return n
    return None


def analyze(
    inventory: list[dict[str, Any]],
    requirements: list[Requirement],
) -> GapAnalysis:
    """Compare `inventory` against `requirements` and classify each gap."""
    matches: list[GapMatch] = []
    for req in requirements:
        entry = _find_in_inventory(inventory, req)
        if entry is None:
            matches.append(GapMatch(requirement=req, status=STATUS_MISSING))
            continue
        rating = _entry_rating(entry)
        if req.min_rating is not None and (rating is None or rating < req.min_rating):
            matches.append(
                GapMatch(
                    requirement=req,
                    status=STATUS_PARTIAL,
                    inventory_entry=entry,
                )
            )
            continue
        matches.append(
            GapMatch(
                requirement=req,
                status=STATUS_MATCHED,
                inventory_entry=entry,
            )
        )
    return GapAnalysis(matches=tuple(matches))


def _find_in_inventory(
    inventory: list[dict[str, Any]], req: Requirement
) -> dict[str, Any] | None:
    """Locate the inventory entry that satisfies `req`, if any.

    Matching is tried in priority order:

    1. ESCO URI match — when both sides carry the same code.
    2. Exact (case-insensitive) preferred-label match.
    3. Synonym match through the ESCO catalogue — handles users who
       recorded a skill under one synonym while the opportunity used
       another (e.g. inventory "Python programming" vs. requirement
       "Python (computer programming)").
    """
    if req.esco_code:
        code = req.esco_code
        for entry in inventory:
            if str(entry.get("esco_code") or "") == code:
                return entry

    needle = req.label.strip().lower()
    if not needle:
        return None

    for entry in inventory:
        name = str(entry.get("skill") or "").strip().lower()
        if name == needle:
            return entry

    synonym_labels = _synonym_labels_for(req)
    if synonym_labels:
        for entry in inventory:
            name = str(entry.get("skill") or "").strip().lower()
            if name and name in synonym_labels:
                return entry

    alt_codes = _codes_with_alt_label(needle)
    if alt_codes:
        for entry in inventory:
            code = str(entry.get("esco_code") or "")
            if code and code in alt_codes:
                return entry
    return None


def _synonym_labels_for(req: Requirement) -> set[str]:
    """All lowercase labels (preferred + alt) for the requirement's ESCO skill.

    Used when the requirement carries a URI (or was promoted to one) so we
    can match a free-text inventory entry recorded under a synonym.
    """
    if not req.esco_code:
        return set()
    skill = taxonomy.find_skill_by_uri(req.esco_code)
    if skill is None:
        return set()
    out = {skill.preferred_label.lower()}
    out.update(alt.lower() for alt in skill.alt_labels)
    return out


def _codes_with_alt_label(label_lower: str) -> set[str]:
    """Return ESCO URIs whose preferred label or any alt label equals `label_lower`."""
    out: set[str] = set()
    for skill in taxonomy.load_skills():
        if skill.preferred_label.lower() == label_lower:
            out.add(skill.uri)
            continue
        for alt in skill.alt_labels:
            if alt.lower() == label_lower:
                out.add(skill.uri)
                break
    return out


def _entry_rating(entry: dict[str, Any]) -> int | None:
    try:
        return int(entry.get("rating"))
    except (TypeError, ValueError):
        return None


# --- Description scanning (fallback for postings without required_skills) ---

# Labels shorter than this are skipped to avoid false positives from
# single-character abbreviations ("R", "C") appearing as random words.
_MIN_SCAN_LABEL_LEN = 3

_DESCRIPTION_HEADING_RE = re.compile(
    r"^##\s+Description\s*\n(.*?)(?=^##\s|\Z)",
    re.MULTILINE | re.DOTALL,
)


@dataclass(frozen=True)
class InventoryHit:
    """An inventory skill confirmed to appear in an opportunity's prose."""

    entry: dict[str, Any]
    context: str

    @property
    def label(self) -> str:
        return str(self.entry.get("skill") or "")

    @property
    def rating(self) -> int | None:
        try:
            return int(self.entry.get("rating"))
        except (TypeError, ValueError):
            return None

    @property
    def example(self) -> str:
        return str(self.entry.get("example") or "")

    @property
    def esco_code(self) -> str:
        return str(self.entry.get("esco_code") or "")


def extract_description_section(body: str) -> str:
    """Return the text under the ``## Description`` heading in `body`.

    Stops at the next H2 heading. Returns the empty string when the body
    has no ``## Description`` section or when the section is empty.
    """
    if not body:
        return ""
    match = _DESCRIPTION_HEADING_RE.search(body)
    if not match:
        return ""
    return match.group(1).strip()


def find_inventory_skills_in_text(
    inventory: list[dict[str, Any]], text: str
) -> list[InventoryHit]:
    """Return inventory skills that appear (word-bounded) in `text`.

    For each inventory entry, scans the entry's own label plus — when an
    ESCO code is recorded — that skill's preferred and alt-labels. The
    first occurrence wins for the context snippet. Skills not found in
    the text are omitted (no "missing" output: pure software can't
    reliably know what's missing from prose).
    """
    if not text or not text.strip() or not inventory:
        return []

    hits: list[InventoryHit] = []
    for entry in inventory:
        labels = _entry_search_labels(entry)
        position = _first_label_match(text, labels)
        if position is None:
            continue
        start, end = position
        hits.append(
            InventoryHit(entry=entry, context=_context_window(text, start, end))
        )
    return hits


def _entry_search_labels(entry: dict[str, Any]) -> list[str]:
    """All scannable labels for an inventory entry (preferred + ESCO alts)."""
    out: list[str] = []
    own = str(entry.get("skill") or "").strip()
    if own:
        out.append(own)
    code = entry.get("esco_code")
    if code:
        skill = taxonomy.find_skill_by_uri(str(code))
        if skill is not None:
            if skill.preferred_label:
                out.append(skill.preferred_label)
            out.extend(skill.alt_labels)
    return [label for label in out if len(label) >= _MIN_SCAN_LABEL_LEN]


def _first_label_match(text: str, labels: list[str]) -> tuple[int, int] | None:
    """First word-bounded match of any `label` in `text` (case-insensitive)."""
    if not labels:
        return None
    # Longest-first so multi-word labels beat their shorter sub-labels at
    # the same position.
    sorted_labels = sorted(set(labels), key=len, reverse=True)
    pattern = r"\b(" + "|".join(re.escape(lbl) for lbl in sorted_labels) + r")\b"
    match = re.search(pattern, text, re.IGNORECASE)
    if match is None:
        return None
    return match.start(), match.end()


_CONTEXT_CHARS_EACH_SIDE = 60


def _context_window(text: str, start: int, end: int) -> str:
    """Return a short, word-bounded snippet of `text` around ``[start:end]``.

    Trims to the nearest whitespace so the snippet doesn't begin or end
    on a partial word, normalizes internal whitespace, and prepends /
    appends an ellipsis when the text was truncated on either side.
    """
    left = max(0, start - _CONTEXT_CHARS_EACH_SIDE)
    right = min(len(text), end + _CONTEXT_CHARS_EACH_SIDE)
    if left > 0:
        next_space = text.find(" ", left, start)
        if next_space != -1:
            left = next_space + 1
    if right < len(text):
        prev_space = text.rfind(" ", end, right)
        if prev_space != -1:
            right = prev_space
    snippet = " ".join(text[left:right].split())
    if not snippet:
        return ""
    if left > 0:
        snippet = "…" + snippet
    if right < len(text):
        snippet = snippet + "…"
    return snippet
