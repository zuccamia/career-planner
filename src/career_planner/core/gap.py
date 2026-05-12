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
from functools import lru_cache
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

# Labels shorter than this are skipped to avoid catastrophic false positives
# from single-character abbreviations ("R", "C") appearing as random words.
_MIN_SCAN_LABEL_LEN = 3

_DESCRIPTION_HEADING_RE = re.compile(
    r"^##\s+Description\s*\n(.*?)(?=^##\s|\Z)",
    re.MULTILINE | re.DOTALL,
)


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


@lru_cache(maxsize=1)
def _label_index() -> tuple[dict[str, str], re.Pattern[str] | None]:
    """Build a ``{lowercase_label: skill_uri}`` index and a single matcher.

    The matcher is a single compiled alternation of word-bounded labels
    sorted longest-first so "Python (computer programming)" wins over a
    nested "Python" when both happen to appear. Labels shorter than
    :data:`_MIN_SCAN_LABEL_LEN` are excluded.
    """
    label_to_uri: dict[str, str] = {}
    for skill in taxonomy.load_skills():
        for label in (skill.preferred_label, *skill.alt_labels):
            label_l = label.strip().lower()
            if len(label_l) < _MIN_SCAN_LABEL_LEN:
                continue
            # first-write-wins so a preferred label keeps its URI when an
            # alt-label collides across skills.
            label_to_uri.setdefault(label_l, skill.uri)

    if not label_to_uri:
        return {}, None

    sorted_labels = sorted(label_to_uri.keys(), key=len, reverse=True)
    pattern = r"\b(" + "|".join(re.escape(lbl) for lbl in sorted_labels) + r")\b"
    return label_to_uri, re.compile(pattern, re.IGNORECASE)


def scan_text_for_skills(text: str) -> list[Requirement]:
    """Find ESCO skills mentioned in `text` by word-bounded label match.

    Used as a fallback for the gap command when an opportunity has no
    ``required_skills`` listed. Returns one :class:`Requirement` per
    unique skill (by ESCO URI), label set to the canonical preferred
    label so the gap report reads cleanly. No min_rating is inferred.

    This is heuristic — callers should make clear in the rendered output
    that these requirements came from prose, not a curated list.
    """
    if not text or not text.strip():
        return []
    label_to_uri, regex = _label_index()
    if regex is None:
        return []

    seen: dict[str, None] = {}
    for match in regex.finditer(text):
        uri = label_to_uri.get(match.group(1).lower())
        if uri and uri not in seen:
            seen[uri] = None

    out: list[Requirement] = []
    for uri in seen:
        skill = taxonomy.find_skill_by_uri(uri)
        if skill is None:
            continue
        out.append(
            Requirement(
                label=skill.preferred_label, esco_code=uri, min_rating=None
            )
        )
    return out
