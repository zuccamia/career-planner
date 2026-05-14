"""Opportunity file I/O for career-planner.

Opportunity entries live as Markdown files with a YAML frontmatter block under
``opportunities/`` in the workspace. This module owns slug generation, file
discovery, frontmatter parsing/serialization, and the basic URL fetch + HTML
title extraction used by ``career opportunity add --url``.
"""

from __future__ import annotations

import html
import json
import re
import urllib.parse
from dataclasses import dataclass
from datetime import date, datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

OPPORTUNITIES_RELPATH = Path("opportunities")
FRONTMATTER_DELIM = "---"
TEMPLATE_NAME = "opportunity.md"

# Status values are free-form strings — users track interview stages and
# pipeline state however they want (e.g. "applied", "OA", "first interview",
# "onsite", "offer_negotiation"). Only the closed set below has special
# meaning downstream; everything else is "open" for dashboard purposes.
CLOSED_STATUSES: frozenset[str] = frozenset({"closed", "rejected", "withdrawn"})


def is_open_status(status: str) -> bool:
    """Return True for any status not in :data:`CLOSED_STATUSES`."""
    return (status or "").strip().lower() not in CLOSED_STATUSES


def shorten_location(location: str, *, max_len: int = 22) -> str:
    """Compact a multi-part location for tabular display.

    Keeps the leading two comma-separated parts (typically city + region)
    and drops the country tail. Truncates with an ellipsis when the result
    still exceeds ``max_len``. Single-part locations (e.g. ``"Remote"``) are
    returned unchanged aside from length capping.
    """
    text = (location or "").strip()
    if not text:
        return ""
    parts = [p.strip() for p in text.split(",") if p.strip()]
    if not parts:
        return ""
    short = ", ".join(parts[:2])
    if len(short) > max_len:
        return short[: max_len - 1] + "…"
    return short

_SLUG_STRIP_RE = re.compile(r"[^a-z0-9]+")
_TITLE_RE = re.compile(
    r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL
)
_JSON_LD_RE = re.compile(
    r"<script[^>]*type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
    re.IGNORECASE | re.DOTALL,
)
_ISO_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


@dataclass(frozen=True)
class Opportunity:
    """An opportunity parsed from a Markdown file."""

    slug: str
    path: Path
    frontmatter: dict[str, Any]
    body: str

    @property
    def title(self) -> str:
        return str(self.frontmatter.get("title") or self.slug)

    @property
    def status(self) -> str:
        return str(self.frontmatter.get("status") or "")

    @property
    def company(self) -> str:
        return str(self.frontmatter.get("company") or "")

    @property
    def role(self) -> str:
        return str(self.frontmatter.get("role") or "")

    @property
    def location(self) -> str:
        return str(self.frontmatter.get("location") or "")

    @property
    def deadline(self) -> str:
        value = self.frontmatter.get("deadline")
        return "" if value is None else str(value)


def opportunities_dir(workspace: Path) -> Path:
    """Return the path to the ``opportunities/`` directory in a workspace."""
    return workspace / OPPORTUNITIES_RELPATH


def opportunity_path(workspace: Path, slug: str) -> Path:
    """Return the path to an opportunity file (does not check existence)."""
    return opportunities_dir(workspace) / f"{slug}.md"


def slugify(title: str) -> str:
    """Convert an opportunity title to a filesystem-safe slug.

    Returns ``"opportunity"`` if `title` contains no alphanumerics.
    """
    s = _SLUG_STRIP_RE.sub("-", title.lower()).strip("-")
    return s or "opportunity"


def unique_slug(workspace: Path, slug: str) -> str:
    """Return `slug` unchanged if free, else append ``-2``, ``-3``, … ."""
    base = slug or "opportunity"
    candidate = base
    n = 2
    while opportunity_path(workspace, candidate).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def render_template(*, title: str, url: str = "", created: date | None = None) -> str:
    """Render the opportunity Markdown template with the given fields."""
    template = (
        resources.files("career_planner")
        .joinpath("data", "templates", TEMPLATE_NAME)
        .read_text(encoding="utf-8")
    )
    created_str = (created or date.today()).isoformat()
    safe_title = title.replace('"', '\\"')
    safe_url = url.replace('"', '\\"')
    return (
        template.replace("{title}", safe_title)
        .replace("{url}", safe_url)
        .replace("{created}", created_str)
    )


def create_opportunity(
    workspace: Path,
    *,
    title: str,
    url: str = "",
    extra: dict[str, Any] | None = None,
    body_description: str = "",
    created: date | None = None,
) -> Path:
    """Create a new opportunity file in the workspace and return its path.

    A unique slug is derived from `title`. Extra frontmatter fields in
    `extra` are merged on top of the rendered template (useful for
    URL-extracted fields like company and location). `body_description` is
    inserted under the ``## Description`` heading in the Markdown body.
    """
    opportunities_dir(workspace).mkdir(parents=True, exist_ok=True)
    slug = unique_slug(workspace, slugify(title))
    target = opportunity_path(workspace, slug)
    contents = render_template(title=title, url=url, created=created)

    if extra or body_description:
        front, body = parse_markdown(contents)
        if extra:
            for key, value in extra.items():
                if value not in (None, "", []):
                    front[key] = value
        if body_description:
            body = _inject_description(body, body_description)
        contents = serialize_markdown(front, body)

    target.write_text(contents, encoding="utf-8")
    return target


def _inject_description(body: str, description: str) -> str:
    """Insert plain-text `description` under the body's ``## Description`` heading."""
    text = description.strip()
    if not text:
        return body
    heading = "## Description"
    if heading not in body:
        return body + f"\n\n{heading}\n\n{text}\n"
    return body.replace(
        f"{heading}\n\n",
        f"{heading}\n\n{text}\n\n",
        1,
    )


def parse_markdown(text: str) -> tuple[dict[str, Any], str]:
    """Split a Markdown file into ``(frontmatter_dict, body)``.

    Files without a leading ``---`` block are treated as body-only and return
    an empty frontmatter dict.
    """
    if not text.startswith(FRONTMATTER_DELIM):
        return {}, text
    rest = text[len(FRONTMATTER_DELIM):]
    if rest.startswith("\n"):
        rest = rest[1:]
    end = rest.find(f"\n{FRONTMATTER_DELIM}")
    if end == -1:
        return {}, text
    yaml_block = rest[:end]
    body = rest[end + len(FRONTMATTER_DELIM) + 1:]
    if body.startswith("\n"):
        body = body[1:]
    try:
        data = yaml.safe_load(yaml_block) or {}
    except yaml.YAMLError:
        return {}, text
    if not isinstance(data, dict):
        return {}, text
    return data, body


def serialize_markdown(frontmatter: dict[str, Any], body: str) -> str:
    """Inverse of :func:`parse_markdown`."""
    yaml_block = yaml.safe_dump(
        frontmatter, sort_keys=False, allow_unicode=True
    ).rstrip("\n")
    body = body if body.endswith("\n") else body + "\n"
    return f"{FRONTMATTER_DELIM}\n{yaml_block}\n{FRONTMATTER_DELIM}\n{body}"


def load_opportunity(workspace: Path, slug: str) -> Opportunity | None:
    """Load and parse an opportunity by slug. Returns None if missing."""
    path = opportunity_path(workspace, slug)
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    front, body = parse_markdown(text)
    return Opportunity(slug=slug, path=path, frontmatter=front, body=body)


def list_opportunities(
    workspace: Path, *, status: str | None = None
) -> list[Opportunity]:
    """Return all opportunities, optionally filtered by status."""
    folder = opportunities_dir(workspace)
    if not folder.exists():
        return []
    out: list[Opportunity] = []
    for path in sorted(folder.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        front, body = parse_markdown(text)
        opp = Opportunity(
            slug=path.stem, path=path, frontmatter=front, body=body
        )
        if status and opp.status.lower() != status.lower():
            continue
        out.append(opp)
    return out


def find_opportunity(workspace: Path, query: str) -> list[Opportunity]:
    """Return opportunities matching `query` by slug (exact, then substring).

    The match is case-insensitive on the slug and on the frontmatter title.
    """
    q = query.strip().lower()
    if not q:
        return []
    if q.endswith(".md"):
        q = q[:-3]

    all_opps = list_opportunities(workspace)
    exact = [o for o in all_opps if o.slug.lower() == q]
    if exact:
        return exact
    partial = [
        o for o in all_opps
        if q in o.slug.lower() or q in o.title.lower()
    ]
    return partial


# --- URL fetching / HTML extraction ---


_OPPORTUNITY_FIELDS: tuple[str, ...] = (
    "title",
    "role",
    "company",
    "location",
    "work_type",
    "date_posted",
    "deadline",
    "salary_min",
    "salary_max",
    "salary_currency",
)


def extract_job_posting(html_text: str) -> dict[str, Any]:
    """Best-effort extraction of structured job posting data from HTML.

    Tries, in order:

    1. ``<script type="application/ld+json">`` blocks with a Schema.org
       ``JobPosting`` object. This is the richest source — Google Jobs
       requires it for indexing, so most reputable job boards embed it.
    2. Open Graph and standard meta tags (``og:title``, ``og:description``,
       ``og:site_name``) for sites that don't ship JSON-LD.
    3. The raw ``<title>`` element as a last resort.

    Returns a dict of frontmatter-shaped fields. The special ``description``
    key (when present) is plain text intended for the Markdown body, not
    the frontmatter. Missing fields are absent rather than ``None`` so
    callers can blindly merge the result on top of the template.
    """
    posting = _find_job_posting_jsonld(html_text)
    if posting is not None:
        return _job_posting_to_fields(posting)

    out: dict[str, Any] = {}
    og_title = _extract_meta(html_text, "og:title")
    og_site = _extract_meta(html_text, "og:site_name")
    og_desc = _extract_meta(html_text, "og:description")
    if og_title:
        out["title"] = og_title
    if og_site:
        out["company"] = og_site
    if og_desc:
        out["description"] = og_desc
    if out:
        return out

    tag = _TITLE_RE.search(html_text)
    if tag:
        candidate = re.sub(r"\s+", " ", tag.group(1)).strip()
        if candidate:
            out["title"] = html.unescape(candidate)
    return out


def extract_title_from_html(html_text: str) -> str:
    """Back-compat wrapper: return just the extracted title (or "")."""
    return str(extract_job_posting(html_text).get("title", ""))


_LLM_EXTRACTION_FIELDS = """\
- title: full opportunity title combining role and company (e.g. "Senior \
Engineer at Acme"); never null
- role: the job title alone (e.g. "Senior Engineer")
- company: hiring organization name
- location: "City, Region, Country" or "Remote"; null if not stated
- work_type: one of "remote" (fully remote), "hybrid" (any in-office \
expectation alongside remote work), "in-person" (fully onsite), or null
- date_posted: ISO date (YYYY-MM-DD) when the posting was published, or null
- deadline: ISO date application deadline, or null
- salary_min: integer expressing the full amount (150000, not 150), or null
- salary_max: integer expressing the full amount, or null
- salary_currency: 3-letter ISO currency code (USD, EUR, GBP, ...), or null
- required_skills: array of short skill phrases the role calls out \
("Python", "AWS", "distributed systems"); [] if none are stated
- description: 2–5 short paragraphs of plain text summarizing the role, \
its responsibilities, and the team — for the Markdown body, not frontmatter
"""


def llm_extract_posting(
    html_text: str,
    llm_config: Any,
    *,
    max_chars: int = 60_000,
) -> dict[str, Any]:
    """Pure-LLM extraction of a job posting from raw HTML.

    Strips the page to plain text, sends it to the configured LLM, and
    asks for the full structured field set in one JSON response. Returns
    a dict in the same frontmatter shape as :func:`extract_job_posting`,
    including the special ``description`` key meant for the Markdown body.

    Raises :class:`LLMAPIError` (from the adapter) on network/API failure
    and :class:`json.JSONDecodeError` when the response is not valid
    JSON — the command layer is expected to catch both and fall back to
    :func:`extract_job_posting` so the user still gets a usable file.
    """
    from career_planner.core import llm as llm_core

    body_text = _html_to_text(html_text)
    if len(body_text) > max_chars:
        body_text = body_text[:max_chars]

    system = (
        "You extract structured fields from job postings. Respond with a "
        "single JSON object using exactly the requested keys. Use null "
        "for any value you cannot determine confidently from the posting. "
        "Do not invent values."
    )
    user = (
        f"Extract these fields from the job posting below:\n"
        f"{_LLM_EXTRACTION_FIELDS}\n"
        f"<posting>\n{body_text}\n</posting>"
    )

    response = llm_core.complete(
        llm_config,
        system=system,
        user=user,
        json_prefill=True,
        max_tokens=4000,
    )
    data = json.loads(response)
    if not isinstance(data, dict):
        return {}
    return _coerce_llm_extraction(data)


def _coerce_llm_extraction(data: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize a full-extraction LLM response."""
    out: dict[str, Any] = {}

    for key in ("title", "role", "company", "location", "description"):
        value = data.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                out[key] = stripped

    work_type = data.get("work_type")
    if isinstance(work_type, str):
        choice = work_type.strip().lower()
        if choice in {"remote", "hybrid", "in-person"}:
            out["work_type"] = choice

    for key in ("date_posted", "deadline"):
        value = data.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if _ISO_DATE_RE.match(stripped):
                out[key] = stripped[:10]

    for key in ("salary_min", "salary_max"):
        value = data.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            out[key] = value
        elif isinstance(value, float) and value.is_integer():
            out[key] = int(value)

    currency = data.get("salary_currency")
    if isinstance(currency, str):
        code = currency.strip().upper()
        if re.fullmatch(r"[A-Z]{3}", code):
            out["salary_currency"] = code

    skills = data.get("required_skills")
    if isinstance(skills, list):
        cleaned: list[str] = []
        seen: set[str] = set()
        for entry in skills:
            if not isinstance(entry, str):
                continue
            text = entry.strip()
            key = text.lower()
            if not text or key in seen:
                continue
            seen.add(key)
            cleaned.append(text)
        if cleaned:
            out["required_skills"] = cleaned

    return out


def _find_job_posting_jsonld(html_text: str) -> dict[str, Any] | None:
    """Return the first JSON-LD ``JobPosting`` node found, or None."""
    for match in _JSON_LD_RE.finditer(html_text):
        raw = match.group(1).strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        posting = _select_job_posting(data)
        if posting is not None:
            return posting
    return None


def _select_job_posting(data: Any) -> dict[str, Any] | None:
    """Walk a JSON-LD payload and return the first JobPosting node."""
    if isinstance(data, dict):
        if _is_job_posting(data):
            return data
        graph = data.get("@graph")
        if isinstance(graph, list):
            for node in graph:
                found = _select_job_posting(node)
                if found is not None:
                    return found
    elif isinstance(data, list):
        for node in data:
            found = _select_job_posting(node)
            if found is not None:
                return found
    return None


def _is_job_posting(node: dict[str, Any]) -> bool:
    type_field = node.get("@type")
    if isinstance(type_field, str):
        return type_field == "JobPosting"
    if isinstance(type_field, list):
        return any(t == "JobPosting" for t in type_field)
    return False


def _job_posting_to_fields(posting: dict[str, Any]) -> dict[str, Any]:
    """Project a Schema.org JobPosting onto our frontmatter fields."""
    result: dict[str, Any] = {}

    role_title = str(posting.get("title") or "").strip()
    company = _organization_name(posting.get("hiringOrganization"))

    if role_title:
        result["role"] = role_title
        result["title"] = (
            f"{role_title} at {company}" if company else role_title
        )
    if company:
        result["company"] = company

    location = _format_job_location(posting.get("jobLocation"))
    if location:
        result["location"] = location

    work_type = _work_type_from_jsonld(posting)
    if work_type:
        result["work_type"] = work_type

    posted = _date_only(posting.get("datePosted"))
    if posted:
        result["date_posted"] = posted

    valid_through = _date_only(posting.get("validThrough"))
    if valid_through:
        result["deadline"] = valid_through

    result.update(_salary_from_jsonld(posting.get("baseSalary")))

    skills = _skills_from_jsonld(posting)
    if skills:
        result["required_skills"] = skills

    description = _html_to_text(str(posting.get("description") or ""))
    if description:
        result["description"] = description
        # Fall back to body-text inference for fields the JSON-LD didn't
        # carry — common on ATSes (e.g. Eightfold) that stuff the salary
        # disclosure and work-site policy into prose rather than the
        # structured baseSalary/jobLocationType nodes.
        if "salary_min" not in result and "salary_max" not in result:
            result.update(extract_salary_from_text(description))
        if "work_type" not in result:
            work_type = extract_work_type_from_text(description)
            if work_type:
                result["work_type"] = work_type

    return result


_SKILL_SPLIT_RE = re.compile(r"[,;\n•|]+")


def _skills_from_jsonld(posting: dict[str, Any]) -> list[str]:
    """Extract required skills from a Schema.org JobPosting node.

    Reads ``skills`` (current property) with a fallback to the deprecated
    ``skillsRequired``. Values can be a string, a list of strings, a
    DefinedTerm node, or a list of DefinedTerm nodes — all are coerced to
    a deduplicated list of trimmed phrases, preserving input order.
    """
    raw = posting.get("skills")
    if raw in (None, "", []):
        raw = posting.get("skillsRequired")
    items = _coerce_skill_items(raw)
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _coerce_skill_items(value: Any) -> list[str]:
    if isinstance(value, str):
        return _split_skill_string(value)
    if isinstance(value, list):
        out: list[str] = []
        for entry in value:
            out.extend(_coerce_skill_items(entry))
        return out
    if isinstance(value, dict):
        name = value.get("name")
        if isinstance(name, str) and name.strip():
            return [name.strip()]
    return []


def _split_skill_string(text: str) -> list[str]:
    parts = _SKILL_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def _organization_name(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or "").strip()
    if isinstance(value, list) and value:
        return _organization_name(value[0])
    if isinstance(value, str):
        return value.strip()
    return ""


def _format_job_location(value: Any) -> str:
    """Build a ``locality, region, country`` string from a Place node."""
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, dict):
        return ""
    address = value.get("address")
    if not isinstance(address, dict):
        # Some sites put a bare name on jobLocation itself.
        name = value.get("name")
        return str(name).strip() if isinstance(name, str) else ""
    parts: list[str] = []
    for key in ("addressLocality", "addressRegion"):
        v = address.get(key)
        if isinstance(v, str) and v.strip():
            parts.append(v.strip())
    country = address.get("addressCountry")
    if isinstance(country, dict):
        country = country.get("name")
    if isinstance(country, str) and country.strip():
        country = country.strip()
        # Some pages stuff the country into addressRegion (e.g. "WA,US") —
        # skip the trailing country to avoid "Redmond, WA,US, US".
        if not parts or country.lower() not in parts[-1].lower():
            parts.append(country)
    return ", ".join(parts)


def _work_type_from_jsonld(posting: dict[str, Any]) -> str:
    """Return "remote" when the posting is explicitly TELECOMMUTE."""
    location_type = posting.get("jobLocationType")
    if isinstance(location_type, str):
        if location_type.upper() == "TELECOMMUTE":
            return "remote"
    elif isinstance(location_type, list):
        for entry in location_type:
            if isinstance(entry, str) and entry.upper() == "TELECOMMUTE":
                return "remote"
    return ""


def _salary_from_jsonld(value: Any) -> dict[str, Any]:
    """Extract ``salary_{min,max,currency}`` from a baseSalary MonetaryAmount."""
    if not isinstance(value, dict):
        return {}
    out: dict[str, Any] = {}
    currency = value.get("currency")
    if isinstance(currency, str) and currency.strip():
        out["salary_currency"] = currency.strip()
    inner = value.get("value")
    if isinstance(inner, dict):
        lo = inner.get("minValue")
        hi = inner.get("maxValue")
        single = inner.get("value")
        if _is_number(lo):
            out["salary_min"] = lo
        if _is_number(hi):
            out["salary_max"] = hi
        if "salary_min" not in out and "salary_max" not in out and _is_number(single):
            out["salary_min"] = single
            out["salary_max"] = single
    elif _is_number(inner):
        out["salary_min"] = inner
        out["salary_max"] = inner
    return out


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _date_only(value: Any) -> str:
    """Return the leading ``YYYY-MM-DD`` portion of an ISO date(time) string."""
    if not value:
        return ""
    match = _ISO_DATE_RE.match(str(value))
    return match.group(1) if match else ""


def _extract_meta(html_text: str, name: str) -> str:
    """Best-effort meta-tag value for ``name=...`` or ``property=...``."""
    pattern = (
        r"<meta\s+[^>]*(?:name|property)=[\"']"
        + re.escape(name)
        + r"[\"'][^>]*content=[\"']([^\"']+)[\"']"
    )
    alt_pattern = (
        r"<meta\s+[^>]*content=[\"']([^\"']+)[\"'][^>]*(?:name|property)=[\"']"
        + re.escape(name)
        + r"[\"']"
    )
    for regex in (pattern, alt_pattern):
        match = re.search(regex, html_text, re.IGNORECASE)
        if match:
            candidate = html.unescape(match.group(1)).strip()
            if candidate:
                return candidate
    return ""


def _html_to_text(html_text: str) -> str:
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


# --- Body-text inference (used when JSON-LD frontmatter is missing) ---


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
    ``$150-200K``, ``150K-200K USD``, ``€80K-€100K`` — and returns the same
    frontmatter shape produced by :func:`extract_job_posting`
    (``salary_min``, ``salary_max``, ``salary_currency``). Returns an empty
    dict when no range can be parsed.

    Used as a fallback by ``career criteria check`` when the opportunity's
    salary frontmatter fields are blank.
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


_USER_AGENT = "career-planner/0.1 (+https://github.com/career-planner)"


def fetch_url(url: str, *, timeout: float = 10.0) -> str:
    """Fetch a URL and return its body as text.

    For Eightfold-hosted careers pages (Microsoft, ServiceNow, Capital One,
    etc.) the public URL is a JavaScript SPA whose initial HTML carries
    almost no job-specific content; we route those through
    :func:`_fetch_eightfold`, which calls the underlying positions API and
    synthesizes an HTML document the regular extractors can consume.

    Raises whatever ``httpx`` raises on failure — callers convert that into a
    user-friendly error.
    """
    import httpx

    pid = _eightfold_pid(url)
    if pid:
        try:
            return _fetch_eightfold(url, pid, timeout=timeout)
        except (httpx.HTTPError, ValueError, KeyError, json.JSONDecodeError):
            # If the API detour fails for any reason, fall through to the
            # plain HTML fetch so the user still gets *something* usable.
            pass

    response = httpx.get(
        url,
        timeout=timeout,
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT},
    )
    response.raise_for_status()
    return response.text


# --- Eightfold ATS detour -------------------------------------------------
#
# Eightfold powers the careers sites for Microsoft, ServiceNow, Capital
# One, Bristol Myers Squibb, Domino's, and many other large employers.
# Every page is a thin SPA shell — the job description, salary disclosure,
# and work-site policy are fetched client-side from a JSON API. A plain
# httpx.get on the public URL yields only the shell, so JSON-LD and
# body-text extraction find almost nothing. The detour calls the same API
# the browser does and re-emits a minimal HTML document with a synthesized
# Schema.org JobPosting block plus the description HTML, which the rest of
# the pipeline (JSON-LD parser, body inference, LLM extractor) consumes
# without further changes.


_EIGHTFOLD_HOST_RE = re.compile(
    r"^(apply\.careers\.[a-z0-9-]+(?:\.[a-z]+)+|[a-z0-9-]+\.eightfold\.ai)$",
    re.IGNORECASE,
)
_EIGHTFOLD_CANONICAL_PATH_RE = re.compile(r"/careers/job/(\d+)")
_EIGHTFOLD_PID_PARAMS: tuple[str, ...] = ("pid", "jid")


def _eightfold_pid(url: str) -> str:
    """Return the Eightfold position ID if `url` is Eightfold-shaped, else ""."""
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return ""
    host = parsed.netloc.lower().split(":", 1)[0]
    if not _EIGHTFOLD_HOST_RE.match(host):
        return ""
    qs = urllib.parse.parse_qs(parsed.query)
    for key in _EIGHTFOLD_PID_PARAMS:
        values = qs.get(key)
        if values and values[0].isdigit():
            return values[0]
    match = _EIGHTFOLD_CANONICAL_PATH_RE.search(parsed.path)
    if match:
        return match.group(1)
    return ""


def _fetch_eightfold(url: str, pid: str, *, timeout: float) -> str:
    """Fetch the Eightfold positions API and return a synthesized HTML doc."""
    import httpx

    parsed = urllib.parse.urlsplit(url)
    api_url = f"{parsed.scheme}://{parsed.netloc}/api/apply/v2/jobs/{pid}"
    response = httpx.get(
        api_url,
        timeout=timeout,
        follow_redirects=True,
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError("Eightfold API returned a non-object payload")
    return _eightfold_to_synthesized_html(data, url)


def _eightfold_to_synthesized_html(
    data: dict[str, Any], original_url: str
) -> str:
    """Build a minimal HTML doc embedding the API result as JSON-LD + body."""
    role_title = str(data.get("name") or "").strip()
    description_html = str(data.get("job_description") or "")
    company = _company_from_eightfold_host(original_url)

    posting: dict[str, Any] = {
        "@context": "https://schema.org",
        "@type": "JobPosting",
    }
    if role_title:
        posting["title"] = role_title
    if company:
        posting["hiringOrganization"] = {
            "@type": "Organization",
            "name": company,
        }

    location_str = _eightfold_pick_location(data)
    place = _eightfold_place_from_string(location_str)
    if place is not None:
        posting["jobLocation"] = place

    posted = _unix_to_iso(data.get("t_create"))
    if posted:
        posting["datePosted"] = posted

    flex = data.get("location_flexibility") or data.get("work_location_option")
    location_type = _eightfold_location_type(flex)
    if location_type:
        posting["jobLocationType"] = location_type

    if description_html:
        posting["description"] = description_html

    # Two views of the same data: the JSON-LD <script> block is for the
    # deterministic extractor, and a small visible metadata block at the top
    # of <body> is for the LLM extractor, which sees only tag-stripped text
    # (and strips script/style content along the way). Without the body
    # block, the LLM would miss location/date_posted/etc. that only live in
    # the API JSON. Salary and work-site policy come back the other way —
    # they live in the description prose, not the JSON — so we surface
    # those in the same labeled block too. Otherwise the LLM, anchoring on
    # the labeled fields it sees, tends to leave salary blank.
    description_text = _html_to_text(description_html) if description_html else ""
    inferred_salary = (
        extract_salary_from_text(description_text) if description_text else {}
    )
    inferred_work_type = (
        extract_work_type_from_text(description_text) if description_text else ""
    )

    meta_lines: list[str] = []
    if role_title:
        meta_lines.append(f"<p>Role: {html.escape(role_title)}</p>")
    if company:
        meta_lines.append(f"<p>Company: {html.escape(company)}</p>")
    if location_str:
        meta_lines.append(f"<p>Location: {html.escape(location_str)}</p>")
    if posted:
        meta_lines.append(f"<p>Date posted: {html.escape(posted)}</p>")
    salary_line = _format_salary_meta(inferred_salary)
    if salary_line:
        meta_lines.append(f"<p>{salary_line}</p>")
    work_site = _work_site_label(location_type, inferred_work_type)
    if work_site:
        meta_lines.append(f"<p>Work site: {work_site}</p>")

    json_ld = json.dumps(posting, ensure_ascii=False)
    title_text = html.escape(role_title or "Job posting")
    return (
        "<!doctype html><html><head>"
        f"<title>{title_text}</title>"
        '<script type="application/ld+json">'
        f"{json_ld}"
        "</script>"
        "</head><body>"
        f"{''.join(meta_lines)}"
        f"{description_html}"
        "</body></html>"
    )


def _eightfold_pick_location(data: dict[str, Any]) -> str:
    """Pick the most informative location string from an Eightfold payload."""
    primary = data.get("location")
    if isinstance(primary, str) and primary.strip():
        return primary.strip()
    locations = data.get("locations")
    if isinstance(locations, list):
        for entry in locations:
            if isinstance(entry, str) and entry.strip():
                return entry.strip()
    return ""


def _eightfold_place_from_string(location_str: str) -> dict[str, Any] | None:
    """Convert an Eightfold "Country, Region, City" string to a Place node.

    Eightfold consistently formats `location` as ``"Country, Region, City"``
    (e.g. ``"United States, Washington, Redmond"``). Anything that doesn't
    split cleanly is returned as a bare ``name`` so the downstream
    formatter still has something to show.
    """
    text = location_str.strip()
    if not text:
        return None
    parts = [p.strip() for p in text.split(",") if p.strip()]
    address: dict[str, Any] = {"@type": "PostalAddress"}
    if len(parts) >= 3:
        address["addressCountry"] = parts[0]
        address["addressRegion"] = parts[1]
        address["addressLocality"] = parts[-1]
    elif len(parts) == 2:
        address["addressCountry"] = parts[0]
        address["addressLocality"] = parts[1]
    else:
        return {"@type": "Place", "name": text}
    return {"@type": "Place", "address": address}


def _eightfold_location_type(value: Any) -> str:
    """Map Eightfold's flexibility hints onto Schema.org jobLocationType."""
    if not isinstance(value, str):
        return ""
    norm = value.strip().lower()
    # Eightfold uses things like "remote", "remoteGlobal", "remoteLocal",
    # "onsite", "hybrid". Only the remote bucket has a Schema.org analogue.
    if norm.startswith("remote") or norm == "telecommute":
        return "TELECOMMUTE"
    return ""


def _format_salary_meta(salary: dict[str, Any]) -> str:
    """Render an inferred salary dict as a labeled line, or "" if empty."""
    lo = salary.get("salary_min")
    hi = salary.get("salary_max")
    currency = salary.get("salary_currency") or ""
    if lo is None and hi is None:
        return ""
    if lo is not None and hi is not None:
        amount = f"{lo:,} - {hi:,}"
    else:
        amount = f"{(lo if lo is not None else hi):,}"
    return f"Salary: {currency} {amount}".strip()


def _work_site_label(location_type: str, inferred_work_type: str) -> str:
    """Map structured + inferred work-type signals to a display label."""
    if location_type == "TELECOMMUTE":
        return "Remote"
    if inferred_work_type == "remote":
        return "Remote"
    if inferred_work_type == "hybrid":
        return "Hybrid"
    if inferred_work_type == "in-person":
        return "In-person"
    return ""


def _company_from_eightfold_host(url: str) -> str:
    """Derive a hiring-org name from an Eightfold-hosted careers URL.

    ``apply.careers.microsoft.com`` → ``"Microsoft"``.
    ``acme-corp.eightfold.ai`` → ``"Acme Corp"``.
    Returns ``""`` when the host doesn't follow either convention.
    """
    try:
        host = urllib.parse.urlsplit(url).netloc.lower().split(":", 1)[0]
    except ValueError:
        return ""
    match = re.match(r"^apply\.careers\.([a-z0-9-]+)\.[a-z]+(?:\.[a-z]+)*$", host)
    if match:
        return match.group(1).replace("-", " ").title()
    match = re.match(r"^([a-z0-9-]+)\.eightfold\.ai$", host)
    if match and match.group(1) != "apply":
        return match.group(1).replace("-", " ").title()
    return ""


def _unix_to_iso(value: Any) -> str:
    """Return ``YYYY-MM-DD`` for a unix-seconds timestamp, else ""."""
    if isinstance(value, bool):
        return ""
    if not isinstance(value, (int, float)):
        return ""
    try:
        return (
            datetime.fromtimestamp(int(value), tz=timezone.utc).date().isoformat()
        )
    except (OverflowError, OSError, ValueError):
        return ""
