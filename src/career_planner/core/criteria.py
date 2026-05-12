"""Job criteria read/write and opportunity matching for career-planner.

All access to ``criteria.yml`` flows through this module. The criteria file
captures the user's job preferences across five dimensions — function,
culture, growth, compensation, location — each with positive and negative
phrase lists plus a ``dealbreakers`` list that gets matched against an
opportunity for violation flagging.

Pure software — no LLM involved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from career_planner.core import opportunities as opp_core

CRITERIA_RELPATH = Path("criteria.yml")

DIMENSIONS: tuple[str, ...] = (
    "function",
    "culture",
    "growth",
    "compensation",
    "location",
)

# Per-dimension list fields that carry positive (things the user wants) and
# negative (things they want to avoid) phrases. Compensation has no list of
# negatives — its "negative" signal comes from the structured salary check.
_POSITIVE_FIELDS: dict[str, tuple[str, ...]] = {
    "function": ("want",),
    "culture": ("preferred",),
    "growth": ("motivators",),
    "compensation": ("other_important",),
    "location": ("preferred",),
}
_NEGATIVE_FIELDS: dict[str, tuple[str, ...]] = {
    "function": ("dread",),
    "culture": ("avoid",),
    "growth": ("stuck_signals",),
    "compensation": (),
    "location": (),
}

# Fields that count toward a dimension being "filled in" for the show command.
# A dimension is empty when none of these has any content.
_COMPLETENESS_FIELDS: dict[str, tuple[str, ...]] = {
    "function": ("want", "dread", "dealbreakers"),
    "culture": ("preferred", "avoid", "dealbreakers"),
    "growth": ("goal_2_3_years", "motivators", "stuck_signals", "dealbreakers"),
    "compensation": (
        "base_minimum",
        "base_target",
        "other_important",
        "dealbreakers",
    ),
    "location": (
        "preferred",
        "willing_to_relocate",
        "work_type",
        "constraints",
        "dealbreakers",
    ),
}

STATUS_STRONG = "strong"
STATUS_OK = "ok"
STATUS_WEAK = "weak"
STATUS_VIOLATION = "violation"
STATUS_UNKNOWN = "unknown"

# Minimum phrase length to scan for — single-character entries would match
# constantly. Matches the threshold used in core/gap.py for the same reason.
_MIN_PHRASE_LEN = 3

# Context window for snippets shown next to a phrase match.
_CONTEXT_CHARS_EACH_SIDE = 60


# --- file I/O ---


def criteria_path(workspace: Path) -> Path:
    """Return the path to ``criteria.yml`` inside a workspace."""
    return workspace / CRITERIA_RELPATH


def load_criteria(workspace: Path) -> dict[str, Any]:
    """Read the criteria dict from ``criteria.yml``. Empty dict if missing."""
    path = criteria_path(workspace)
    if not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw if isinstance(raw, dict) else {}


def save_criteria(workspace: Path, data: dict[str, Any]) -> None:
    """Persist `data` to ``criteria.yml``."""
    path = criteria_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


# --- dimension introspection ---


def dimension_data(criteria: dict[str, Any], name: str) -> dict[str, Any]:
    """Return the dict for `name`, coerced to a dict (empty when missing)."""
    raw = criteria.get(name)
    return raw if isinstance(raw, dict) else {}


def is_dimension_empty(name: str, data: dict[str, Any]) -> bool:
    """A dimension is empty when none of its completeness fields has content."""
    for field in _COMPLETENESS_FIELDS.get(name, ()):
        if _has_value(data.get(field)):
            return False
    return True


def missing_fields(name: str, data: dict[str, Any]) -> tuple[str, ...]:
    """Return the completeness fields for `name` that are currently empty."""
    out: list[str] = []
    for field in _COMPLETENESS_FIELDS.get(name, ()):
        if not _has_value(data.get(field)):
            out.append(field)
    return tuple(out)


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, (list, tuple, set)):
        return any(_has_value(v) for v in value)
    if isinstance(value, dict):
        return any(_has_value(v) for v in value.values())
    return True


# --- check_against_opportunity ---


@dataclass(frozen=True)
class PhraseMatch:
    """A criteria phrase found verbatim in the opportunity text."""

    phrase: str
    context: str


@dataclass(frozen=True)
class Violation:
    """A criteria dealbreaker (or structured concern) tripped by an opportunity."""

    dimension: str
    phrase: str
    source: str  # "dealbreaker" | "salary_floor" | "work_type" | ...
    context: str = ""


@dataclass(frozen=True)
class DimensionResult:
    """How an opportunity scores against one criteria dimension."""

    name: str
    status: str
    positives: tuple[PhraseMatch, ...]
    negatives: tuple[PhraseMatch, ...]
    violations: tuple[Violation, ...]
    notes: tuple[str, ...] = ()


@dataclass(frozen=True)
class CriteriaCheck:
    """The full outcome of checking an opportunity against the criteria."""

    opportunity_slug: str
    opportunity_title: str
    dimensions: tuple[DimensionResult, ...]

    @property
    def violations(self) -> tuple[Violation, ...]:
        return tuple(v for d in self.dimensions for v in d.violations)

    @property
    def has_violations(self) -> bool:
        return any(d.violations for d in self.dimensions)

    @property
    def alignment(self) -> float:
        """Fraction of non-unknown dimensions whose status is strong or ok."""
        scored = [d for d in self.dimensions if d.status != STATUS_UNKNOWN]
        if not scored:
            return 0.0
        good = sum(1 for d in scored if d.status in (STATUS_STRONG, STATUS_OK))
        return good / len(scored)


def check_against_opportunity(
    criteria: dict[str, Any], opp: opp_core.Opportunity
) -> CriteriaCheck:
    """Compare `opp` against `criteria` and return a structured result."""
    scan_text = _opportunity_scan_text(opp)

    results: list[DimensionResult] = []
    for dim in DIMENSIONS:
        data = dimension_data(criteria, dim)
        positives = tuple(
            _scan_phrases(_collect_phrases(data, _POSITIVE_FIELDS[dim]), scan_text)
        )
        negatives = tuple(
            _scan_phrases(_collect_phrases(data, _NEGATIVE_FIELDS[dim]), scan_text)
        )

        dealbreaker_phrases = _collect_phrases(data, ("dealbreakers",))
        violations: list[Violation] = [
            Violation(
                dimension=dim,
                phrase=match.phrase,
                source="dealbreaker",
                context=match.context,
            )
            for match in _scan_phrases(dealbreaker_phrases, scan_text)
        ]
        notes: list[str] = []

        if dim == "compensation":
            extra, comp_notes = _check_compensation(data, opp.frontmatter)
            violations.extend(extra)
            notes.extend(comp_notes)
        elif dim == "location":
            extra, loc_notes = _check_location(data, opp.frontmatter)
            violations.extend(extra)
            notes.extend(loc_notes)

        status = _classify(
            positives=positives,
            negatives=negatives,
            violations=tuple(violations),
            data=data,
            dim=dim,
            opp_front=opp.frontmatter,
        )

        results.append(
            DimensionResult(
                name=dim,
                status=status,
                positives=positives,
                negatives=negatives,
                violations=tuple(violations),
                notes=tuple(notes),
            )
        )

    return CriteriaCheck(
        opportunity_slug=opp.slug,
        opportunity_title=opp.title,
        dimensions=tuple(results),
    )


def _opportunity_scan_text(opp: opp_core.Opportunity) -> str:
    """Build the text blob used for phrase scanning.

    Combines the description section of the body with the body itself and
    a handful of frontmatter fields (title, location, work_type) so a
    phrase like "in-person" can be caught no matter where it lives.
    """
    parts: list[str] = []
    front = opp.frontmatter or {}
    for key in ("title", "role", "company", "location", "work_type"):
        value = front.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value)
    body = opp.body or ""
    if body:
        parts.append(body)
    return "\n".join(parts)


def _collect_phrases(data: dict[str, Any], fields: tuple[str, ...]) -> list[str]:
    """Flatten `fields` from `data` into a list of trimmed phrases."""
    out: list[str] = []
    for field in fields:
        value = data.get(field)
        if not isinstance(value, list):
            continue
        for item in value:
            if not isinstance(item, str):
                continue
            phrase = item.strip()
            if len(phrase) >= _MIN_PHRASE_LEN:
                out.append(phrase)
    return out


def _scan_phrases(phrases: list[str], text: str) -> list[PhraseMatch]:
    """Return phrases that appear (word-bounded, case-insensitive) in `text`.

    Each phrase is reported at most once; duplicates in the input list
    collapse to a single match in the output, preserving input order.
    """
    if not phrases or not text:
        return []
    seen: set[str] = set()
    out: list[PhraseMatch] = []
    for phrase in phrases:
        key = phrase.lower()
        if key in seen:
            continue
        seen.add(key)
        position = _first_word_bounded_match(text, phrase)
        if position is None:
            continue
        start, end = position
        out.append(
            PhraseMatch(
                phrase=phrase,
                context=_context_window(text, start, end),
            )
        )
    return out


def _first_word_bounded_match(text: str, phrase: str) -> tuple[int, int] | None:
    pattern = r"\b" + re.escape(phrase) + r"\b"
    match = re.search(pattern, text, re.IGNORECASE)
    if match is None:
        return None
    return match.start(), match.end()


def _context_window(text: str, start: int, end: int) -> str:
    """Return a short, word-bounded snippet of `text` around ``[start:end]``."""
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


# --- structured dimension checks ---


def _check_compensation(
    data: dict[str, Any], front: dict[str, Any]
) -> tuple[list[Violation], list[str]]:
    """Structured salary check: floor and currency consistency.

    Returns ``(violations, notes)``. Notes are informational lines (e.g.
    "Salary meets target") that get surfaced beneath the dimension.
    """
    violations: list[Violation] = []
    notes: list[str] = []

    floor = _coerce_number(data.get("base_minimum"))
    target = _coerce_number(data.get("base_target"))
    desired_currency = _normalize_currency(data.get("currency"))

    salary_min = _coerce_number(front.get("salary_min"))
    salary_max = _coerce_number(front.get("salary_max"))
    opp_currency = _normalize_currency(front.get("salary_currency"))

    if salary_min is None and salary_max is None:
        if floor or target:
            notes.append("opportunity has no salary listed")
        return violations, notes

    top = salary_max if salary_max is not None else salary_min
    bottom = salary_min if salary_min is not None else salary_max

    if (
        desired_currency
        and opp_currency
        and desired_currency != opp_currency
    ):
        notes.append(
            f"currency mismatch: criteria={desired_currency}, "
            f"opportunity={opp_currency}"
        )

    if floor is not None and top is not None and top < floor:
        violations.append(
            Violation(
                dimension="compensation",
                phrase=f"salary below floor of {floor}",
                source="salary_floor",
                context=_format_salary_range(salary_min, salary_max, opp_currency),
            )
        )
    elif target is not None and bottom is not None and bottom >= target:
        notes.append(
            f"salary meets target of {target} "
            f"({_format_salary_range(salary_min, salary_max, opp_currency)})"
        )
    elif floor is not None and bottom is not None and bottom >= floor:
        notes.append(
            f"salary clears floor of {floor} "
            f"({_format_salary_range(salary_min, salary_max, opp_currency)})"
        )
    return violations, notes


def _check_location(
    data: dict[str, Any], front: dict[str, Any]
) -> tuple[list[Violation], list[str]]:
    """Structured location check: work_type compatibility."""
    violations: list[Violation] = []
    notes: list[str] = []

    desired = _normalize_work_type(data.get("work_type"))
    opp_work = _normalize_work_type(front.get("work_type"))

    if desired and opp_work and not _work_type_compatible(desired, opp_work):
        violations.append(
            Violation(
                dimension="location",
                phrase=f"work_type '{opp_work}' does not match criteria '{desired}'",
                source="work_type",
            )
        )
    elif desired and opp_work and _work_type_compatible(desired, opp_work):
        notes.append(f"work_type '{opp_work}' matches criteria '{desired}'")
    return violations, notes


def _classify(
    *,
    positives: tuple[PhraseMatch, ...],
    negatives: tuple[PhraseMatch, ...],
    violations: tuple[Violation, ...],
    data: dict[str, Any],
    dim: str,
    opp_front: dict[str, Any],
) -> str:
    """Decide a dimension's overall status."""
    if violations:
        return STATUS_VIOLATION
    if is_dimension_empty(dim, data):
        return STATUS_UNKNOWN

    pos = len(positives)
    neg = len(negatives)

    # Compensation has structured signal: a salary that meets the target
    # is a strong fit even if no positive phrases match.
    if dim == "compensation":
        target = _coerce_number(data.get("base_target"))
        floor = _coerce_number(data.get("base_minimum"))
        salary_min = _coerce_number(opp_front.get("salary_min"))
        salary_max = _coerce_number(opp_front.get("salary_max"))
        bottom = salary_min if salary_min is not None else salary_max
        if target is not None and bottom is not None and bottom >= target:
            return STATUS_STRONG
        if floor is not None and bottom is not None and bottom >= floor:
            return STATUS_OK if neg == 0 else STATUS_WEAK

    if pos == 0 and neg == 0:
        return STATUS_UNKNOWN
    if neg > pos:
        return STATUS_WEAK
    if pos >= 2 and neg == 0:
        return STATUS_STRONG
    return STATUS_OK


# --- helpers ---


def _coerce_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value else None
    if isinstance(value, str):
        cleaned = value.replace(",", "").replace("_", "").strip()
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _normalize_currency(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_work_type(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    # Collapse common spellings: "in person", "in-office", "on-site".
    if any(s in text for s in ("in-person", "in person", "onsite", "on-site", "in-office")):
        return "in-person"
    if "hybrid" in text:
        return "hybrid"
    if "remote" in text or "telecommute" in text:
        return "remote"
    return text


def _work_type_compatible(desired: str, actual: str) -> bool:
    """Does `actual` satisfy `desired`?

    "remote" desires only accept "remote"; "hybrid" accepts hybrid or remote;
    "in-person" accepts in-person or hybrid. Anything we don't recognise on
    either side falls through to a permissive match so we don't false-flag.
    """
    if desired == actual:
        return True
    if "or" in desired or "/" in desired or "," in desired:
        # Free-form "remote or hybrid" — accept any token that appears.
        return actual in desired
    if desired == "hybrid":
        return actual in ("hybrid", "remote")
    if desired == "in-person":
        return actual in ("in-person", "hybrid")
    return False


def _format_salary_range(lo: float | None, hi: float | None, currency: str) -> str:
    lo_s = "" if lo is None else _format_number(lo)
    hi_s = "" if hi is None else _format_number(hi)
    if lo_s and hi_s and lo_s != hi_s:
        amount = f"{lo_s}–{hi_s}"
    else:
        amount = lo_s or hi_s
    return f"{amount} {currency}".strip()


def _format_number(value: float) -> str:
    if value.is_integer():
        return f"{int(value)}"
    return f"{value:g}"
