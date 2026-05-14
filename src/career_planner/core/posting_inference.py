"""Body-text inference for job postings.

Pure regex-based extractors that pull salary ranges and work-type signals
out of free-text descriptions. Used as a fallback when JSON-LD frontmatter
is missing or incomplete, and as enrichment for the Eightfold ATS detour
(whose API surfaces those fields only in the description prose).

Also exposes the HTML → plain-text reducer used by every extractor that
needs to read tag-stripped body content.
"""

from __future__ import annotations

import html
import re
from typing import Any


def html_to_text(html_text: str) -> str:
    """Convert a fragment of HTML into a readable plain-text Markdown block."""
    if not html_text:
        return ""
    text = html_text
    text = re.sub(
        r"<script\b[^>]*>.*?</script\s*>", "", text, flags=re.IGNORECASE | re.DOTALL
    )
    text = re.sub(
        r"<style\b[^>]*>.*?</style\s*>", "", text, flags=re.IGNORECASE | re.DOTALL
    )
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</div\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>", "- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</li\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# Salary range with a currency mark *before* the lower bound:
#   $150K-$200K, $150,000-$200,000, $150-200K, USD 150K to 200K, €80K-€100K
_SALARY_PREFIX_RANGE_RE = re.compile(
    r"""
    (?P<cur>\$|US\$|USD|£|GBP|€|EUR)\s*
    (?P<lo>\d{1,3}(?:,\d{3})+|\d+)
    \s*(?P<lo_k>[Kk])?
    \s*(?:-|–|—|\s+to\s+)
    \s*(?:\$|US\$|USD|£|GBP|€|EUR)?\s*
    (?P<hi>\d{1,3}(?:,\d{3})+|\d+)
    \s*(?P<hi_k>[Kk])?
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Salary range with the currency mark *after* the upper bound:
#   150,000-200,000 USD, 80-100K EUR
_SALARY_POSTFIX_RANGE_RE = re.compile(
    r"""
    \b(?P<lo>\d{1,3}(?:,\d{3})+|\d+)
    \s*(?P<lo_k>[Kk])?
    \s*(?:-|–|—|\s+to\s+)
    \s*(?P<hi>\d{1,3}(?:,\d{3})+|\d+)
    \s*(?P<hi_k>[Kk])?
    \s*(?P<cur>USD|EUR|GBP|CAD|AUD)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

_CURRENCY_NORMALIZE: dict[str, str] = {
    "$": "USD",
    "US$": "USD",
    "USD": "USD",
    "£": "GBP",
    "GBP": "GBP",
    "€": "EUR",
    "EUR": "EUR",
    "CAD": "CAD",
    "AUD": "AUD",
}


def extract_salary_from_text(text: str) -> dict[str, Any]:
    """Best-effort salary-range extraction from a free-text body.

    Recognises common posting formats — ``$150K-$200K``, ``$150,000-$200,000``,
    ``$150-200K``, ``150K-200K USD``, ``€80K-€100K`` — and returns a dict
    in the same shape used in opportunity frontmatter (``salary_min``,
    ``salary_max``, ``salary_currency``). Returns an empty dict when no
    range can be parsed.
    """
    if not text:
        return {}

    for pattern in (_SALARY_PREFIX_RANGE_RE, _SALARY_POSTFIX_RANGE_RE):
        match = pattern.search(text)
        if match is None:
            continue
        lo_val = _parse_salary_number(match.group("lo"), match.group("lo_k"))
        hi_val = _parse_salary_number(match.group("hi"), match.group("hi_k"))
        if lo_val is None or hi_val is None:
            continue
        # Shared-K rule: "$150-200K" — upper has K, lower doesn't, lower is
        # tiny relative to upper, so the K applies to both bounds.
        if (
            match.group("hi_k")
            and not match.group("lo_k")
            and lo_val < 1000
            and hi_val >= 1000
        ):
            lo_val *= 1000
        if lo_val > hi_val:
            # Out-of-order pair is most likely a phone number or version
            # string sneaking past — skip rather than emit nonsense.
            continue
        cur_raw = (match.group("cur") or "").upper()
        cur = _CURRENCY_NORMALIZE.get(cur_raw, "")
        out: dict[str, Any] = {"salary_min": lo_val, "salary_max": hi_val}
        if cur:
            out["salary_currency"] = cur
        return out
    return {}


def _parse_salary_number(num_str: str, k_suffix: str | None) -> int | None:
    if not num_str:
        return None
    try:
        n = int(num_str.replace(",", ""))
    except ValueError:
        return None
    if k_suffix:
        n *= 1000
    return n


# Work-type patterns in priority order. Strongest signals first; the first
# match wins so "fully remote" beats a stray "hybrid" later in the post.
_WORK_TYPE_PATTERNS: tuple[tuple["re.Pattern[str]", str], ...] = (
    (
        re.compile(r"\b(?:fully|100%|completely)\s+remote\b", re.IGNORECASE),
        "remote",
    ),
    (
        re.compile(r"\bremote[- ](?:first|only|eligible)\b", re.IGNORECASE),
        "remote",
    ),
    (
        re.compile(r"\bwork\s+from\s+(?:anywhere|home)\b", re.IGNORECASE),
        "remote",
    ),
    (
        re.compile(
            r"\bfully\s+(?:in[- ]?office|in[- ]?person|onsite|on[- ]?site)\b",
            re.IGNORECASE,
        ),
        "in-person",
    ),
    (
        re.compile(
            r"\b(?:5|five)\s+days?(?:\s+(?:a|per)\s+week)?\s+"
            r"(?:in[- ]?office|onsite|on[- ]?site|in[- ]?person)\b",
            re.IGNORECASE,
        ),
        "in-person",
    ),
    (re.compile(r"\bhybrid\b", re.IGNORECASE), "hybrid"),
    (
        re.compile(
            r"\b[1-4]\s+days?(?:\s+(?:a|per)\s+week)?\s+"
            r"(?:in[- ]?office|onsite|on[- ]?site|in[- ]?person)\b",
            re.IGNORECASE,
        ),
        "hybrid",
    ),
)


def extract_work_type_from_text(text: str) -> str:
    """Best-effort work-type inference from a free-text body.

    Returns ``"remote"``, ``"hybrid"``, ``"in-person"``, or ``""`` when no
    strong signal is found. Patterns are evaluated in priority order so
    "fully remote" beats a softer "hybrid" mention later in the post.

    Soft mentions like a bare "remote" or "remote-friendly" are deliberately
    skipped — they're too ambiguous (often "occasional remote work allowed"
    rather than a true remote role).
    """
    if not text:
        return ""
    for pattern, work_type in _WORK_TYPE_PATTERNS:
        if pattern.search(text):
            return work_type
    return ""
