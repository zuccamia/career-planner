"""Opportunity file I/O for career-planner.

Opportunity entries live as Markdown files with a YAML frontmatter block under
``opportunities/`` in the workspace. This module owns slug generation, file
discovery, frontmatter parsing/serialization, structured (JSON-LD / Open Graph)
extraction, the optional LLM extraction pass, and the URL fetcher used by
``career opportunity add --url``.

Body-text inference (salary regex, work-type regex) and the Eightfold ATS
detour live in :mod:`career_planner.core.opportunity.inference` and
:mod:`career_planner.core.opportunity.eightfold` respectively.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from datetime import date
from importlib import resources
from pathlib import Path
from typing import Any

import yaml

from . import eightfold as eightfold_core
from .inference import (
    extract_salary_from_text,
    extract_work_type_from_text,
    html_to_text,
)

# Test-facing re-exports — historic underscore names so external callers
# (including tests) keep working after the module split.
_html_to_text = html_to_text
_eightfold_pid = eightfold_core.eightfold_pid
_company_from_eightfold_host = eightfold_core.company_from_host

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


def replace_section(body: str, heading: str, content: str) -> str:
    """Replace a markdown section's body, preserving the heading and siblings.

    `heading` is the exact heading line (e.g. ``"## Pros"``). The section
    ends at the next H2 heading (``"## …"``) or end of body. `content` is
    the new section body (without the heading) — it's placed between
    blank lines under the heading. If `heading` is not present, the new
    section is appended at the end of `body`.

    This is a "this entire section is auto-managed" primitive: any
    existing content under the heading is discarded. Use carefully —
    only on sections the tool has claimed ownership of.
    """
    lines = body.split("\n")
    heading_idx: int | None = None
    for i, line in enumerate(lines):
        if line == heading:
            heading_idx = i
            break

    if heading_idx is None:
        return body.rstrip() + f"\n\n{heading}\n\n{content}\n"

    end_idx = len(lines)
    for i in range(heading_idx + 1, len(lines)):
        if lines[i].startswith("## "):
            end_idx = i
            break

    new_lines = (
        lines[: heading_idx + 1]
        + [""]
        + content.split("\n")
        + [""]
        + lines[end_idx:]
    )
    return "\n".join(new_lines)


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

    Raises :class:`LLMAPIError` on network/API failure or when the response
    isn't valid JSON. The command layer catches that and falls back to
    :func:`extract_job_posting` so the user still gets a usable file.
    """
    from career_planner.core import llm as llm_core

    body_text = html_to_text(html_text)
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

    data = llm_core.complete_json(
        llm_config,
        system=system,
        user=user,
        max_tokens=4000,
    )
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




_USER_AGENT = "career-planner/0.1 (+https://github.com/career-planner)"


def fetch_url(url: str, *, timeout: float = 10.0) -> str:
    """Fetch a URL and return its body as text.

    For Eightfold-hosted careers pages (Microsoft, ServiceNow, Capital One,
    etc.) the public URL is a JavaScript SPA whose initial HTML carries
    almost no job-specific content; we route those through
    :func:`career_planner.core.opportunity.eightfold.fetch_eightfold`, which calls the
    underlying positions API and synthesizes an HTML document the regular
    extractors can consume.

    Raises whatever ``httpx`` raises on failure — callers convert that into a
    user-friendly error.
    """
    import httpx

    pid = eightfold_core.eightfold_pid(url)
    if pid:
        try:
            return eightfold_core.fetch_eightfold(url, pid, timeout=timeout)
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

