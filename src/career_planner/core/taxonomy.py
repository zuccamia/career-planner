"""ESCO/O*NET taxonomy data access for career-planner.

Loads bundled skill and occupation data from src/career_planner/data/.
All taxonomy lookups go through this module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from importlib import resources

import yaml

_TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Skill:
    """A single ESCO skill record."""

    uri: str
    preferred_label: str
    skill_type: str
    reuse_level: str
    description: str
    alt_labels: tuple[str, ...] = ()


@dataclass(frozen=True)
class Occupation:
    """A single ESCO occupation record."""

    uri: str
    preferred_label: str
    isco_code: str
    code: str
    description: str
    alt_labels: tuple[str, ...] = ()


def _read_bundled(name: str) -> str:
    return (
        resources.files("career_planner")
        .joinpath("data", name)
        .read_text(encoding="utf-8")
    )


def _coerce_alt_labels(raw: object) -> tuple[str, ...]:
    if not raw:
        return ()
    if isinstance(raw, str):
        return (raw,)
    return tuple(str(x) for x in raw if x)


@lru_cache(maxsize=1)
def load_skills() -> tuple[Skill, ...]:
    """Return the bundled ESCO skills catalogue (cached)."""
    try:
        raw = yaml.safe_load(_read_bundled("esco-skills.yml")) or {}
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return ()
    items = raw.get("skills") or []
    return tuple(
        Skill(
            uri=str(item.get("uri") or ""),
            preferred_label=str(item.get("preferred_label") or ""),
            skill_type=str(item.get("skill_type") or ""),
            reuse_level=str(item.get("reuse_level") or ""),
            description=str(item.get("description") or ""),
            alt_labels=_coerce_alt_labels(item.get("alt_labels")),
        )
        for item in items
    )


@lru_cache(maxsize=1)
def _skills_by_uri() -> dict[str, Skill]:
    return {s.uri: s for s in load_skills()}


def find_skill_by_uri(uri: str) -> Skill | None:
    """Look up a single skill by its ESCO URI."""
    if not uri:
        return None
    return _skills_by_uri().get(uri)


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def _score(query: str, label: str) -> float:
    """Heuristic fuzzy-match score between a user query and a skill label."""
    q = query.lower().strip()
    lbl = label.lower().strip()
    if not q or not lbl:
        return 0.0
    if q == lbl:
        return 1.0
    if q in lbl:
        return 0.85 + 0.1 * (len(q) / len(lbl))
    q_tokens = _tokens(q)
    l_tokens = _tokens(lbl)
    if q_tokens and q_tokens.issubset(l_tokens):
        return 0.88
    if l_tokens and l_tokens.issubset(q_tokens) and len(lbl) >= 4:
        return 0.78 + 0.1 * (len(lbl) / max(len(q), 1))
    return SequenceMatcher(None, q, lbl).ratio()


def _best_label_score(
    query: str, preferred: str, alts: tuple[str, ...]
) -> tuple[float, bool]:
    """Score a query against a label and its synonyms.

    Returns ``(score, via_preferred)``. ``via_preferred`` is True when the
    chosen score came from the preferred label rather than an alt. Callers
    use it as a tiebreaker so the canonical name wins when scores match.
    """
    best = _score(query, preferred)
    via_preferred = True
    for alt in alts:
        if best >= 1.0 and via_preferred:
            break
        score = _score(query, alt)
        if score > best:
            best = score
            via_preferred = False
    return best, via_preferred


# Auto-accept rule shared by every caller that promotes a free-text query
# to a single ESCO skill (``skills add``, gap-analysis requirement parsing,
# etc.): a perfect or near-perfect match wins outright, otherwise the top
# match needs a noticeable lead over the runner-up. Below this bar we
# treat the query as ambiguous (UI prompts the user; non-UI keeps the raw
# text). Tuned empirically — too lenient and we promote vague single-word
# hits, too strict and we miss obvious synonyms.
CONFIDENT_MATCH_PERFECT = 0.999
CONFIDENT_MATCH_THRESHOLD = 0.85
CONFIDENT_MATCH_LEAD = 0.10


def is_confident_match(matches: list[tuple[Skill, float]]) -> Skill | None:
    """Return the top skill if it dominates the ranked `matches`, else ``None``.

    Use this anywhere a free-text query needs to be auto-promoted to a
    canonical ESCO skill without user disambiguation. Callers that *do*
    have a UI (``skills add``, ``criteria edit``) should still offer a
    manual pick when this returns ``None``.
    """
    if not matches:
        return None
    top, top_score = matches[0]
    if top_score >= CONFIDENT_MATCH_PERFECT:
        return top
    second_score = matches[1][1] if len(matches) > 1 else 0.0
    if (
        top_score >= CONFIDENT_MATCH_THRESHOLD
        and (top_score - second_score) >= CONFIDENT_MATCH_LEAD
    ):
        return top
    return None


def find_skill_matches(
    query: str, *, limit: int = 8, threshold: float = 0.55
) -> list[tuple[Skill, float]]:
    """Fuzzy-match `query` against the ESCO skill catalogue.

    Returns up to `limit` matches with a score >= `threshold`, sorted by score
    descending. An exact (case-insensitive) match scores 1.0; substring and
    word-subset matches score in the 0.8-0.95 range; everything else falls
    back to ``difflib.SequenceMatcher.ratio()``. Alt labels (ESCO synonyms)
    are scored alongside the preferred label; the best hit wins, with the
    preferred label as the tiebreaker.
    """
    if not query or not query.strip():
        return []
    scored: list[tuple[Skill, float, int]] = []
    for skill in load_skills():
        s, via_preferred = _best_label_score(
            query, skill.preferred_label, skill.alt_labels
        )
        if s >= threshold:
            scored.append((skill, s, 0 if via_preferred else 1))
    scored.sort(key=lambda t: (t[1], -t[2]), reverse=True)
    return [(skill, score) for skill, score, _ in scored[:limit]]


def search_skills_text(
    query: str, *, limit: int = 20, threshold: float = 0.5
) -> list[tuple[Skill, float]]:
    """Search ESCO skills by label AND description.

    Use this for the `career skills browse --search` flow where the user may
    type informal phrasing that appears in a skill's description rather than
    its preferred label.
    """
    if not query or not query.strip():
        return []
    q = query.lower().strip()
    q_tokens = _tokens(q)
    scored: list[tuple[Skill, float, int]] = []
    for skill in load_skills():
        label_score, via_preferred = _best_label_score(
            q, skill.preferred_label, skill.alt_labels
        )
        desc_score = _description_score(q_tokens, skill.description)
        if desc_score > label_score:
            s = desc_score
            tie_rank = 2  # description matches lose ties to label matches
        else:
            s = label_score
            tie_rank = 0 if via_preferred else 1
        if s >= threshold:
            scored.append((skill, s, tie_rank))
    scored.sort(key=lambda t: (t[1], -t[2]), reverse=True)
    return [(skill, score) for skill, score, _ in scored[:limit]]


def _description_score(q_tokens: set[str], description: str) -> float:
    """Score a description match by token overlap with the query."""
    if not q_tokens or not description:
        return 0.0
    d_tokens = _tokens(description)
    if not d_tokens:
        return 0.0
    overlap = len(q_tokens & d_tokens)
    if overlap == 0:
        return 0.0
    if overlap == len(q_tokens):
        return 0.75
    return 0.5 * (overlap / len(q_tokens))


# --- Occupations ---


@lru_cache(maxsize=1)
def load_occupations() -> tuple[Occupation, ...]:
    """Return the bundled ESCO occupations (cached)."""
    try:
        raw = yaml.safe_load(_read_bundled("esco-occupations.yml")) or {}
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return ()
    items = raw.get("occupations") or []
    return tuple(
        Occupation(
            uri=str(item.get("uri") or ""),
            preferred_label=str(item.get("preferred_label") or ""),
            isco_code=str(item.get("isco_code") or ""),
            code=str(item.get("code") or ""),
            description=str(item.get("description") or ""),
            alt_labels=_coerce_alt_labels(item.get("alt_labels")),
        )
        for item in items
    )


@lru_cache(maxsize=1)
def _occupations_by_uri() -> dict[str, Occupation]:
    return {o.uri: o for o in load_occupations()}


def find_occupation_by_uri(uri: str) -> Occupation | None:
    if not uri:
        return None
    return _occupations_by_uri().get(uri)


def find_occupation_matches(
    query: str, *, limit: int = 8, threshold: float = 0.55
) -> list[tuple[Occupation, float]]:
    """Fuzzy-match `query` against ESCO occupation titles and their synonyms.

    Preferred-label hits win ties against alt-label hits at the same score,
    so the canonical name surfaces first when a query is a synonym shared
    by multiple occupations.
    """
    if not query or not query.strip():
        return []
    scored: list[tuple[Occupation, float, int]] = []
    for occ in load_occupations():
        s, via_preferred = _best_label_score(
            query, occ.preferred_label, occ.alt_labels
        )
        if s >= threshold:
            scored.append((occ, s, 0 if via_preferred else 1))
    scored.sort(key=lambda t: (t[1], -t[2]), reverse=True)
    return [(occ, score) for occ, score, _ in scored[:limit]]


@lru_cache(maxsize=1)
def load_occupation_skills() -> dict[str, tuple[str, ...]]:
    """Return mapping ``{occupation_uri: (skill_uri, ...)}``."""
    try:
        raw = yaml.safe_load(_read_bundled("esco-occupation-skills.yml")) or {}
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return {}
    mapping = raw.get("mapping") or {}
    return {str(k): tuple(v or ()) for k, v in mapping.items()}


def occupation_skills(occupation_uri: str) -> tuple[Skill, ...]:
    """Return the ``Skill`` records mapped to ``occupation_uri``.

    Skills referenced by the mapping but missing from the curated subset are
    silently dropped.
    """
    uris = load_occupation_skills().get(occupation_uri, ())
    out: list[Skill] = []
    for uri in uris:
        skill = find_skill_by_uri(uri)
        if skill is not None:
            out.append(skill)
    return tuple(out)


# --- Skill hierarchy ---


@lru_cache(maxsize=1)
def load_skill_hierarchy() -> tuple[
    dict[str, tuple[str, ...]], dict[str, tuple[str, ...]]
]:
    """Return ``(parents_of, children_of)`` keyed by skill URI."""
    try:
        raw = yaml.safe_load(_read_bundled("esco-skill-hierarchy.yml")) or {}
    except (FileNotFoundError, ModuleNotFoundError, OSError):
        return {}, {}
    parents = raw.get("parents") or {}
    parents_of: dict[str, tuple[str, ...]] = {
        str(k): tuple(v or ()) for k, v in parents.items()
    }
    children_acc: dict[str, list[str]] = {}
    for child, ps in parents_of.items():
        for parent in ps:
            children_acc.setdefault(parent, []).append(child)
    children_of: dict[str, tuple[str, ...]] = {
        k: tuple(sorted(v)) for k, v in children_acc.items()
    }
    return parents_of, children_of


def hierarchy_roots() -> tuple[str, ...]:
    """Top-level skill URIs — present as parents but not as children."""
    parents_of, _children = load_skill_hierarchy()
    if not parents_of:
        return ()
    all_parents: set[str] = set()
    for ps in parents_of.values():
        all_parents.update(ps)
    return tuple(sorted(all_parents - set(parents_of.keys())))
