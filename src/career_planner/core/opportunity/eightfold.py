"""Eightfold ATS detour for ``career opportunity add --url``.

Eightfold powers the careers sites for Microsoft, ServiceNow, Capital
One, Bristol Myers Squibb, Domino's, and many other large employers.
Every page is a thin SPA shell — the job description, salary disclosure,
and work-site policy are fetched client-side from a JSON API. A plain
``httpx.get`` on the public URL yields only the shell, so JSON-LD and
body-text extraction find almost nothing.

The detour here calls the same API the browser does and re-emits a
minimal HTML document with a synthesized Schema.org JobPosting block plus
the description HTML. The rest of the pipeline (JSON-LD parser, body
inference, LLM extractor) consumes the synthesized document without
further changes.
"""

from __future__ import annotations

import html
import json
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from .inference import (
    extract_salary_from_text,
    extract_work_type_from_text,
    html_to_text,
)

_EIGHTFOLD_HOST_RE = re.compile(
    r"^(apply\.careers\.[a-z0-9-]+(?:\.[a-z]+)+|[a-z0-9-]+\.eightfold\.ai)$",
    re.IGNORECASE,
)
_EIGHTFOLD_CANONICAL_PATH_RE = re.compile(r"/careers/job/(\d+)")
_EIGHTFOLD_PID_PARAMS: tuple[str, ...] = ("pid", "jid")

_USER_AGENT = "career-planner/0.1 (+https://github.com/career-planner)"


def eightfold_pid(url: str) -> str:
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


def fetch_eightfold(url: str, pid: str, *, timeout: float) -> str:
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
    return _to_synthesized_html(data, url)


def _to_synthesized_html(data: dict[str, Any], original_url: str) -> str:
    """Build a minimal HTML doc embedding the API result as JSON-LD + body."""
    role_title = str(data.get("name") or "").strip()
    description_html = str(data.get("job_description") or "")
    company = company_from_host(original_url)

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

    location_str = _pick_location(data)
    place = _place_from_string(location_str)
    if place is not None:
        posting["jobLocation"] = place

    posted = _unix_to_iso(data.get("t_create"))
    if posted:
        posting["datePosted"] = posted

    flex = data.get("location_flexibility") or data.get("work_location_option")
    location_type = _location_type(flex)
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
    description_text = html_to_text(description_html) if description_html else ""
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


def _pick_location(data: dict[str, Any]) -> str:
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


def _place_from_string(location_str: str) -> dict[str, Any] | None:
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


def _location_type(value: Any) -> str:
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


def company_from_host(url: str) -> str:
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
