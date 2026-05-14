"""Job criteria read/write and LLM-driven opportunity checking.

All access to ``criteria.yml`` flows through this module. The criteria file
captures the user's job preferences across five dimensions — function,
culture, growth, compensation, location. Opportunities are checked against
those criteria by sending both to the configured LLM in a single pass.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

import yaml

from career_planner.core import llm
from career_planner.core import opportunity as opp_core
from career_planner.core.coercion import coerce_date, coerce_int
from career_planner.core.workspace import load_yaml_dict, save_yaml_dict

CRITERIA_RELPATH = Path("criteria.yml")

DIMENSIONS: tuple[str, ...] = (
    "function",
    "culture",
    "growth",
    "compensation",
    "location",
)

# Fields that count toward a dimension being "filled in" for the show command.
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

_VALID_STATUSES: frozenset[str] = frozenset(
    {STATUS_STRONG, STATUS_OK, STATUS_WEAK, STATUS_VIOLATION, STATUS_UNKNOWN}
)


# --- file I/O ---


def criteria_path(workspace: Path) -> Path:
    """Return the path to ``criteria.yml`` inside a workspace."""
    return workspace / CRITERIA_RELPATH


def load_criteria(workspace: Path) -> dict[str, Any]:
    """Read the criteria dict from ``criteria.yml``. Empty dict if missing."""
    return load_yaml_dict(criteria_path(workspace))


def save_criteria(workspace: Path, data: dict[str, Any]) -> None:
    """Persist `data` to ``criteria.yml``."""
    save_yaml_dict(criteria_path(workspace), data)


def criteria_hash(data: dict[str, Any]) -> str:
    """Short stable hash of a criteria dict.

    Used by ``career status`` to detect when a cached ``criteria_check``
    block on an opportunity is stale because the criteria changed.
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
    return tuple(
        field
        for field in _COMPLETENESS_FIELDS.get(name, ())
        if not _has_value(data.get(field))
    )


def is_criteria_empty(data: dict[str, Any]) -> bool:
    """True when every dimension has no completeness-field content.

    A freshly-initialized workspace has all five dimension keys present
    but empty — that still counts as "empty" by this rule.
    """
    if not data:
        return True
    return all(
        is_dimension_empty(dim, dimension_data(data, dim)) for dim in DIMENSIONS
    )


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


# --- result dataclasses ---


@dataclass(frozen=True)
class PhraseMatch:
    """A positive or negative signal the LLM found in the opportunity."""

    phrase: str
    context: str = ""


@dataclass(frozen=True)
class Violation:
    """A dealbreaker tripped by the opportunity."""

    dimension: str
    phrase: str
    context: str = ""


@dataclass(frozen=True)
class DimensionResult:
    """How an opportunity scores against one criteria dimension."""

    name: str
    status: str
    positives: tuple[PhraseMatch, ...]
    negatives: tuple[PhraseMatch, ...]
    violations: tuple[Violation, ...]
    summary: str = ""


@dataclass(frozen=True)
class CriteriaCheck:
    """The full outcome of checking an opportunity against the criteria."""

    opportunity_slug: str
    opportunity_title: str
    dimensions: tuple[DimensionResult, ...]
    summary: str = ""

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


# --- LLM check ---


_LLM_SYSTEM = """\
You are an analyst assessing whether a job opportunity matches a person's
career criteria. The criteria has five dimensions: function, culture,
growth, compensation, location. Each has positive lists (want / preferred
/ motivators / other_important), negative lists (dread / avoid /
stuck_signals), and a dealbreakers list. Compensation also has
base_minimum, base_target, currency. Location also has work_type and
willing_to_relocate.

For every dimension, judge how well the opportunity fits and return a
status:
- "strong": clear, multiple positive signals; no concerns
- "ok": acceptable fit; positives outweigh any minor concerns
- "weak": notable concerns or negatives, but no dealbreakers triggered
- "violation": at least one dealbreaker is triggered (explicitly or implicitly)
- "unknown": the dimension is empty in criteria, or the opportunity gives
  insufficient signal to judge

Quote specific text from the opportunity in every `context` field so the
user can audit your reasoning. Be conservative: do not invent positives
or dealbreakers that the opportunity text doesn't support.

Return only JSON in the exact shape requested. No prose outside the JSON.\
"""


_LLM_MAX_TOKENS = 2500


def check_against_opportunity(
    criteria: dict[str, Any],
    opp: opp_core.Opportunity,
    config: llm.LLMConfig,
) -> CriteriaCheck:
    """Ask the configured LLM to judge `opp` against `criteria`.

    Raises :class:`llm.LLMError` on network/API/JSON failures.
    """
    parsed = llm.complete_json(
        config,
        system=_LLM_SYSTEM,
        user=_build_llm_prompt(criteria, opp),
        max_tokens=_LLM_MAX_TOKENS,
    )
    return _build_check_from_response(opp, parsed)


def _build_llm_prompt(
    criteria: dict[str, Any], opp: opp_core.Opportunity
) -> str:
    criteria_yaml = yaml.safe_dump(
        criteria or {}, sort_keys=False, allow_unicode=True
    ).strip()
    frontmatter_yaml = yaml.safe_dump(
        dict(opp.frontmatter or {}), sort_keys=False, allow_unicode=True
    ).strip()
    body = (opp.body or "").strip() or "(no description in body)"

    return (
        "## User criteria\n"
        f"```yaml\n{criteria_yaml}\n```\n\n"
        "## Opportunity frontmatter\n"
        f"```yaml\n{frontmatter_yaml}\n```\n\n"
        "## Opportunity body\n"
        f"{body}\n\n"
        "## Required response shape\n"
        "```json\n"
        "{\n"
        '  "dimensions": [\n'
        "    {\n"
        '      "name": "function|culture|growth|compensation|location",\n'
        '      "status": "strong|ok|weak|violation|unknown",\n'
        '      "summary": "one short sentence on fit for this dimension",\n'
        '      "violations": [{"phrase": "...", "context": "<quote>"}],\n'
        '      "positives":  [{"phrase": "...", "context": "<quote>"}],\n'
        '      "negatives":  [{"phrase": "...", "context": "<quote>"}]\n'
        "    }\n"
        "  ],\n"
        '  "summary": "one or two sentences on overall fit"\n'
        "}\n"
        "```\n"
        "Include all five dimensions. Empty lists are fine."
    )


def _build_check_from_response(
    opp: opp_core.Opportunity, parsed: dict[str, Any]
) -> CriteriaCheck:
    findings_by_name: dict[str, dict[str, Any]] = {}
    for entry in parsed.get("dimensions") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        if name in DIMENSIONS:
            findings_by_name[name] = entry

    dims: list[DimensionResult] = []
    for name in DIMENSIONS:
        finding = findings_by_name.get(name) or {}
        status = str(finding.get("status") or "").strip().lower()
        if status not in _VALID_STATUSES:
            status = STATUS_UNKNOWN
        dims.append(
            DimensionResult(
                name=name,
                status=status,
                positives=_parse_phrases(finding.get("positives")),
                negatives=_parse_phrases(finding.get("negatives")),
                violations=_parse_violations(name, finding.get("violations")),
                summary=str(finding.get("summary") or "").strip(),
            )
        )

    return CriteriaCheck(
        opportunity_slug=opp.slug,
        opportunity_title=opp.title,
        dimensions=tuple(dims),
        summary=str(parsed.get("summary") or "").strip(),
    )


def _parse_phrases(raw: Any) -> tuple[PhraseMatch, ...]:
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
            )
        )
    return tuple(out)


def _parse_violations(dimension: str, raw: Any) -> tuple[Violation, ...]:
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
                context=str(entry.get("context") or "").strip(),
            )
        )
    return tuple(out)


# --- cache read/write ---


@dataclass(frozen=True)
class CachedCheck:
    """Compact summary of a previous ``criteria check`` stored on an opportunity.

    Written to the opportunity's ``criteria_check:`` frontmatter block by
    :func:`save_check_to_opportunity`; read back by ``career status`` and
    ``career opportunity show`` so neither command has to rerun the LLM
    check on every invocation.

    ``stale`` flips True when the criteria the check ran against doesn't
    match the workspace's current ``criteria.yml`` — the cached verdict
    predates a user's recent criteria edit.
    """

    alignment: int  # percent 0-100
    dealbreaker_count: int
    scored_dimensions: int
    checked_at: date | None
    stale: bool

    @property
    def has_violations(self) -> bool:
        return self.dealbreaker_count > 0


def read_cached_check(
    opp: opp_core.Opportunity, *, current_criteria_hash: str
) -> CachedCheck | None:
    """Parse the cached ``criteria_check`` block off `opp`'s frontmatter.

    Returns ``None`` when no check is cached. ``current_criteria_hash``
    drives the ``stale`` flag — callers that read many opportunities
    against one criteria.yml should compute the hash once and pass it in.
    """
    raw = opp.frontmatter.get("criteria_check")
    if not isinstance(raw, dict):
        return None
    stored_hash = str(raw.get("criteria_hash") or "")
    return CachedCheck(
        alignment=coerce_int(raw.get("alignment"), default=0),
        dealbreaker_count=coerce_int(raw.get("dealbreaker_count"), default=0),
        scored_dimensions=coerce_int(raw.get("scored_dimensions"), default=0),
        checked_at=coerce_date(raw.get("checked_at")),
        stale=stored_hash != current_criteria_hash,
    )


def save_check_to_opportunity(
    workspace: Path,
    check: CriteriaCheck,
    criteria_data: dict[str, Any],
    *,
    today: date | None = None,
) -> None:
    """Persist the criteria check onto the opportunity file.

    Writes a compact summary to the ``criteria_check`` frontmatter block
    (read by ``career status`` and ``career opportunity show``) and
    rewrites the body's ``## Pros`` and ``## Cons`` sections with the
    formatted positives/negatives/violations. The ``## Notes`` section
    and everything else in the body are left untouched.
    """
    path = opp_core.opportunity_path(workspace, check.opportunity_slug)
    if not path.exists():
        return

    today = today or date.today()
    text = path.read_text(encoding="utf-8")
    front, body = opp_core.parse_markdown(text)
    front["criteria_check"] = {
        "checked_at": today.isoformat(),
        "alignment": round(check.alignment * 100),
        "dealbreaker_count": len(check.violations),
        "scored_dimensions": sum(
            1 for d in check.dimensions if d.status != STATUS_UNKNOWN
        ),
        "criteria_hash": criteria_hash(criteria_data),
    }

    body = opp_core.replace_section(body, "## Pros", _format_pros(check, today))
    body = opp_core.replace_section(body, "## Cons", _format_cons(check, today))

    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")


# --- pros/cons formatting (body sections owned by criteria check) ---


_DISCLAIMER = (
    "*Auto-generated by `career criteria check` ({date}). "
    "Edit `criteria.yml` and re-run to update.*"
)
_EMPTY = "*(none surfaced)*"


def _format_pros(check: CriteriaCheck, today: date) -> str:
    """Render the positive signals from `check` as the body of ``## Pros``."""
    bullets: list[str] = []
    for dim in check.dimensions:
        for match in dim.positives:
            bullets.append(_format_bullet(dim.name, match.phrase, match.context))
    return _join_section(today, bullets)


def _format_cons(check: CriteriaCheck, today: date) -> str:
    """Render negatives + violations from `check` as the body of ``## Cons``.

    Violations come first and carry a ⚠ marker — they're hard fails. Plain
    negatives follow.
    """
    bullets: list[str] = []
    for violation in check.violations:
        bullet = _format_bullet(
            violation.dimension, violation.phrase, violation.context
        )
        bullets.append(f"⚠ {bullet[2:]} (dealbreaker triggered)")
    for dim in check.dimensions:
        for match in dim.negatives:
            bullets.append(_format_bullet(dim.name, match.phrase, match.context))
    return _join_section(today, bullets)


def _format_bullet(dimension: str, phrase: str, context: str) -> str:
    line = f"- **{dimension}** — {phrase}"
    if context:
        line += f': *"{context}"*'
    return line


def _join_section(today: date, bullets: list[str]) -> str:
    disclaimer = _DISCLAIMER.format(date=today.isoformat())
    body = "\n".join(bullets) if bullets else _EMPTY
    return f"{disclaimer}\n\n{body}"
