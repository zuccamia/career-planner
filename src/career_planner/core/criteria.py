"""Job criteria read/write and opportunity matching for career-planner.

All access to ``criteria.yml`` flows through this module. The criteria file
captures the user's job preferences across five dimensions — function,
culture, growth, compensation, location — each with positive and negative
phrase lists plus a ``dealbreakers`` list that gets matched against an
opportunity for violation flagging.

Pure software — no LLM involved.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from career_planner.core import llm
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


def criteria_hash(data: dict[str, Any]) -> str:
    """Short stable hash of a criteria dict.

    Used to detect when a cached ``criteria_check`` block on an opportunity
    is stale because the underlying criteria changed. Serialization is
    sorted to keep the hash deterministic across reorderings.
    """
    payload = json.dumps(data or {}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


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
    """A criteria phrase found in the opportunity text.

    ``source`` is ``"literal"`` for word-bounded substring hits (the
    default) and ``"llm"`` when the match was surfaced by ``--reason``.
    """

    phrase: str
    context: str
    source: str = "literal"


@dataclass(frozen=True)
class Violation:
    """A criteria dealbreaker (or structured concern) tripped by an opportunity.

    ``source`` distinguishes how the violation was discovered:
    ``"dealbreaker"`` (literal phrase match), ``"salary_floor"`` /
    ``"work_type"`` (structured checks), or ``"llm"`` (AI augmentation).
    """

    dimension: str
    phrase: str
    source: str
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
    ai_note: str = ""


@dataclass(frozen=True)
class CriteriaCheck:
    """The full outcome of checking an opportunity against the criteria."""

    opportunity_slug: str
    opportunity_title: str
    dimensions: tuple[DimensionResult, ...]
    ai_summary: str = ""

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

    @property
    def ai_augmented(self) -> bool:
        return bool(self.ai_summary) or any(d.ai_note for d in self.dimensions)


def check_against_opportunity(
    criteria: dict[str, Any], opp: opp_core.Opportunity
) -> CriteriaCheck:
    """Compare `opp` against `criteria` and return a structured result."""
    scan_text = _opportunity_scan_text(opp)
    effective_front, inferred = _effective_signals(opp)

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
            extra, comp_notes = _check_compensation(data, effective_front, inferred)
            violations.extend(extra)
            notes.extend(comp_notes)
        elif dim == "location":
            extra, loc_notes = _check_location(data, effective_front, inferred)
            violations.extend(extra)
            notes.extend(loc_notes)

        status = _classify(
            positives=positives,
            negatives=negatives,
            violations=tuple(violations),
            data=data,
            dim=dim,
            opp_front=effective_front,
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


# --- cache write -------------------------------------------------------------

# Keys written to the opportunity's ``criteria_check:`` frontmatter block.
# Kept narrow on purpose — the dashboard only needs a summary, and a smaller
# payload keeps the YAML readable when a user opens the .md file directly.
_CACHE_KEYS: tuple[str, ...] = (
    "checked_at",
    "alignment",
    "dealbreaker_count",
    "scored_dimensions",
    "ai_augmented",
    "criteria_hash",
)


def save_check_to_opportunity(
    workspace: Path,
    check: "CriteriaCheck",
    criteria_data: dict[str, Any],
    *,
    today: date | None = None,
) -> None:
    """Persist a compact ``criteria_check`` block onto the opportunity file.

    ``career status`` reads this block to render the fit column without
    rerunning the check. The block is rewritten in place every time the
    user runs ``career criteria check`` so the cache stays aligned with
    the most recent verdict (including LLM-augmented ones).
    """
    path = opp_core.opportunity_path(workspace, check.opportunity_slug)
    if not path.exists():
        return

    text = path.read_text(encoding="utf-8")
    front, body = opp_core.parse_markdown(text)
    front["criteria_check"] = {
        "checked_at": (today or date.today()).isoformat(),
        "alignment": round(check.alignment * 100),
        "dealbreaker_count": len(check.violations),
        "scored_dimensions": sum(
            1 for d in check.dimensions if d.status != STATUS_UNKNOWN
        ),
        "ai_augmented": check.ai_augmented,
        "criteria_hash": criteria_hash(criteria_data),
    }
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")


def _effective_signals(
    opp: opp_core.Opportunity,
) -> tuple[dict[str, Any], set[str]]:
    """Build an effective frontmatter that fills missing salary / work_type
    fields from the opportunity's body text.

    Returns ``(merged_frontmatter, inferred_keys)`` so callers can surface
    the provenance of each value to the user. Existing frontmatter values
    always win — inference only fires when a field is blank.
    """
    front: dict[str, Any] = dict(opp.frontmatter or {})
    inferred: set[str] = set()
    body = opp.body or ""

    has_salary = _looks_like_amount(front.get("salary_min")) or _looks_like_amount(
        front.get("salary_max")
    )
    if not has_salary:
        salary = opp_core.extract_salary_from_text(body)
        for key, value in salary.items():
            front[key] = value
            inferred.add(key)

    if not str(front.get("work_type") or "").strip():
        wt = opp_core.extract_work_type_from_text(body)
        if wt:
            front["work_type"] = wt
            inferred.add("work_type")

    return front, inferred


def _looks_like_amount(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip() not in ("", "0")
    return False


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
    data: dict[str, Any], front: dict[str, Any], inferred: set[str]
) -> tuple[list[Violation], list[str]]:
    """Structured salary check: floor and currency consistency.

    Returns ``(violations, notes)``. Notes are informational lines (e.g.
    "salary meets target") that get surfaced beneath the dimension. When
    ``salary_min`` or ``salary_max`` appear in ``inferred``, the values came
    from the body text rather than the frontmatter — we surface that as a
    note so the user knows the check is best-effort.
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

    salary_inferred = "salary_min" in inferred or "salary_max" in inferred
    if salary_inferred:
        notes.append(
            f"salary inferred from description: "
            f"{_format_salary_range(salary_min, salary_max, opp_currency)}"
        )

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
    data: dict[str, Any], front: dict[str, Any], inferred: set[str]
) -> tuple[list[Violation], list[str]]:
    """Structured location check: work_type compatibility.

    Surfaces a note when ``work_type`` came from body-text inference rather
    than the frontmatter, so the user can tell the difference between an
    authoritative match and a best-effort guess.
    """
    violations: list[Violation] = []
    notes: list[str] = []

    desired = _normalize_work_type(data.get("work_type"))
    opp_work = _normalize_work_type(front.get("work_type"))

    if "work_type" in inferred and opp_work:
        notes.append(f"work_type '{opp_work}' inferred from description")

    if desired and opp_work:
        if _work_type_compatible(desired, opp_work):
            notes.append(f"work_type '{opp_work}' matches criteria '{desired}'")
        else:
            violations.append(
                Violation(
                    dimension="location",
                    phrase=(
                        f"work_type '{opp_work}' does not match criteria "
                        f"'{desired}'"
                    ),
                    source="work_type",
                )
            )
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


# --- LLM augmentation ---


_LLM_SYSTEM = """\
You are an analyst assessing whether a job opportunity matches a person's
career criteria. The criteria has five dimensions: function, culture,
growth, compensation, location. Each has positive lists (want / preferred
/ motivators / other_important), negative lists (dread / avoid /
stuck_signals), and a dealbreakers list. Compensation also has
base_minimum, base_target, currency. Location also has work_type and
willing_to_relocate.

A pure-software check has already done literal phrase matching and
structured numeric / work_type comparison. Your job is to find what
literal matching missed: implicit dealbreaker violations, implicit
positive matches, implicit negative matches that a careful human reader
would catch but a substring search wouldn't.

Be conservative. Only flag something when you can point to specific text
in the opportunity that supports it, and quote that text in the
`context` field. Skip a dimension entirely if you have nothing new to
add.

Return only JSON in the exact shape requested. Do not add prose outside
the JSON.\
"""


_LLM_MAX_TOKENS = 2000


def augment_with_llm(
    check: CriteriaCheck,
    criteria: dict[str, Any],
    opp: opp_core.Opportunity,
    config: llm.LLMConfig,
) -> CriteriaCheck:
    """Return a new :class:`CriteriaCheck` enriched with LLM analysis.

    Sends the criteria, the opportunity, and the pure-software result to
    the configured LLM and merges the response into each dimension. Any
    LLM-surfaced dealbreaker violation forces the dimension status to
    ``STATUS_VIOLATION``. Network or parsing failures raise
    :class:`llm.LLMError` — callers decide whether to fall back.
    """
    prompt = _build_llm_prompt(criteria, opp, check)
    raw = llm.complete(
        config,
        system=_LLM_SYSTEM,
        user=prompt,
        max_tokens=_LLM_MAX_TOKENS,
        json_prefill=True,
    )
    parsed = _parse_llm_response(raw)
    return _merge_llm_findings(check, parsed)


def _build_llm_prompt(
    criteria: dict[str, Any],
    opp: opp_core.Opportunity,
    check: CriteriaCheck,
) -> str:
    """Render the user-message payload for :func:`augment_with_llm`."""
    criteria_yaml = yaml.safe_dump(
        criteria or {}, sort_keys=False, allow_unicode=True
    ).strip()
    frontmatter_yaml = yaml.safe_dump(
        dict(opp.frontmatter or {}), sort_keys=False, allow_unicode=True
    ).strip()
    body = (opp.body or "").strip() or "(no description in body)"
    existing = _serialize_check_for_llm(check)

    return (
        "## User criteria\n"
        f"```yaml\n{criteria_yaml}\n```\n\n"
        "## Opportunity frontmatter\n"
        f"```yaml\n{frontmatter_yaml}\n```\n\n"
        "## Opportunity body\n"
        f"{body}\n\n"
        "## What the pure-software check already found\n"
        f"{existing}\n\n"
        "## Required response shape\n"
        "```json\n"
        "{\n"
        '  "dimensions": [\n'
        "    {\n"
        '      "name": "function|culture|growth|compensation|location",\n'
        '      "summary": "one short sentence on fit for this dimension",\n'
        '      "additional_violations": [{"phrase": "...", "context": "<quote from posting>"}],\n'
        '      "additional_positives": [{"phrase": "...", "context": "<quote from posting>"}],\n'
        '      "additional_negatives": [{"phrase": "...", "context": "<quote from posting>"}]\n'
        "    }\n"
        "  ],\n"
        '  "overall_summary": "one or two sentences on overall fit"\n'
        "}\n"
        "```\n"
        "Empty lists are fine. Omit a dimension entirely if you have "
        "nothing to add."
    )


def _serialize_check_for_llm(check: CriteriaCheck) -> str:
    """One-line-per-dimension summary of the pure-software check."""
    lines: list[str] = []
    for dim in check.dimensions:
        parts = [f"- {dim.name}: status={dim.status}"]
        if dim.violations:
            parts.append(
                "violations=[" + "; ".join(v.phrase for v in dim.violations) + "]"
            )
        if dim.positives:
            parts.append(
                "matched_positives=["
                + "; ".join(p.phrase for p in dim.positives)
                + "]"
            )
        if dim.negatives:
            parts.append(
                "matched_negatives=["
                + "; ".join(n.phrase for n in dim.negatives)
                + "]"
            )
        lines.append("  ".join(parts))
    return "\n".join(lines) if lines else "(nothing surfaced)"


def _parse_llm_response(raw: str) -> dict[str, Any]:
    """Parse the LLM's JSON response, tolerating common stray characters."""
    text = raw.strip()
    # The prefill trick can sometimes produce a stray trailing fence or
    # comment; trim to the outermost JSON object so json.loads succeeds.
    if "{" in text and "}" in text:
        text = text[text.index("{") : text.rindex("}") + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise llm.LLMAPIError(f"LLM returned invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise llm.LLMAPIError("LLM response is not a JSON object")
    return data


def _merge_llm_findings(
    check: CriteriaCheck, parsed: dict[str, Any]
) -> CriteriaCheck:
    """Build a new :class:`CriteriaCheck` with LLM additions folded in."""
    findings_by_name: dict[str, dict[str, Any]] = {}
    for entry in parsed.get("dimensions") or []:
        if isinstance(entry, dict):
            name = str(entry.get("name") or "").strip().lower()
            if name in DIMENSIONS:
                findings_by_name[name] = entry

    new_dims: list[DimensionResult] = []
    for dim in check.dimensions:
        finding = findings_by_name.get(dim.name) or {}
        ai_violations = _llm_violations(dim.name, finding.get("additional_violations"))
        ai_positives = _llm_phrases(finding.get("additional_positives"))
        ai_negatives = _llm_phrases(finding.get("additional_negatives"))
        ai_note = str(finding.get("summary") or "").strip()

        merged_violations = dim.violations + ai_violations
        merged_positives = dim.positives + ai_positives
        merged_negatives = dim.negatives + ai_negatives

        # If the LLM found a dealbreaker the literal scan missed, the
        # dimension is now in violation regardless of its prior status.
        new_status = (
            STATUS_VIOLATION if ai_violations else dim.status
        )

        new_dims.append(
            DimensionResult(
                name=dim.name,
                status=new_status,
                positives=merged_positives,
                negatives=merged_negatives,
                violations=merged_violations,
                notes=dim.notes,
                ai_note=ai_note,
            )
        )

    return CriteriaCheck(
        opportunity_slug=check.opportunity_slug,
        opportunity_title=check.opportunity_title,
        dimensions=tuple(new_dims),
        ai_summary=str(parsed.get("overall_summary") or "").strip(),
    )


def _llm_violations(
    dimension: str, raw: Any
) -> tuple[Violation, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[Violation] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        phrase = str(entry.get("phrase") or "").strip()
        if not phrase:
            continue
        out.append(
            Violation(
                dimension=dimension,
                phrase=phrase,
                source="llm",
                context=str(entry.get("context") or "").strip(),
            )
        )
    return tuple(out)


def _llm_phrases(raw: Any) -> tuple[PhraseMatch, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[PhraseMatch] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        phrase = str(entry.get("phrase") or "").strip()
        if not phrase:
            continue
        out.append(
            PhraseMatch(
                phrase=phrase,
                context=str(entry.get("context") or "").strip(),
                source="llm",
            )
        )
    return tuple(out)
