"""Resume read/write, deterministic markdown render, and AI tailoring.

All access to ``resume.yml`` flows through this module.

The deterministic ``render_markdown`` produces a standard pandoc-compatible
resume from the master content. ``render_tailored`` asks the configured
LLM to rewrite that content for a specific opportunity, emphasizing
JD-relevant phrasing and reordering bullets.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from career_planner.core import llm
from career_planner.core import opportunities as opp_core

RESUME_RELPATH = Path("resume.yml")


# --- file I/O ---


def resume_path(workspace: Path) -> Path:
    """Return the path to ``resume.yml`` inside a workspace."""
    return workspace / RESUME_RELPATH


def load_resume(workspace: Path) -> dict[str, Any]:
    """Read the resume dict from ``resume.yml``. Empty dict if missing."""
    path = resume_path(workspace)
    if not path.exists():
        return {}
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return raw if isinstance(raw, dict) else {}


def save_resume(workspace: Path, data: dict[str, Any]) -> None:
    """Persist `data` to ``resume.yml``."""
    path = resume_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def is_empty(resume: dict[str, Any]) -> bool:
    """True when the resume has neither a name nor any experience entries."""
    header = resume.get("header") or {}
    name = str(header.get("name") or "").strip()
    experience = resume.get("experience") or []
    has_experience = any(
        isinstance(e, dict) and str(e.get("role") or "").strip()
        for e in experience
    )
    return not name and not has_experience


# --- deterministic markdown render ---


def render_markdown(resume: dict[str, Any]) -> str:
    """Render `resume` as a standard pandoc-compatible markdown resume."""
    parts: list[str] = []

    header = resume.get("header") or {}
    name = str(header.get("name") or "").strip() or "Your Name"
    parts.append(f"# {name}\n")

    contact_line = _contact_line(header)
    if contact_line:
        parts.append(contact_line + "\n")

    objective = str(resume.get("objective") or "").strip()
    if objective:
        parts.append("## Objective\n")
        parts.append(objective + "\n")

    experience = _sorted_experience(resume.get("experience") or [])
    if experience:
        parts.append("## Experience\n")
        for entry in experience:
            parts.append(_render_experience_entry(entry))

    education = _sorted_experience(resume.get("education") or [])
    if education:
        parts.append("## Education\n")
        for entry in education:
            parts.append(_render_education_entry(entry))

    for section in resume.get("extras") or []:
        if not isinstance(section, dict):
            continue
        title = str(section.get("title") or "").strip()
        bullets = [str(b).strip() for b in section.get("bullets") or [] if str(b).strip()]
        if not title or not bullets:
            continue
        parts.append(f"## {title}\n")
        parts.append("\n".join(f"- {b}" for b in bullets) + "\n")

    return "\n".join(parts).rstrip() + "\n"


def _contact_line(header: dict[str, Any]) -> str:
    bits: list[str] = []
    for key in ("email", "phone", "location"):
        value = str(header.get(key) or "").strip()
        if value:
            bits.append(value)
    for link in header.get("links") or []:
        if not isinstance(link, dict):
            continue
        label = str(link.get("label") or "").strip()
        url = str(link.get("url") or "").strip()
        if label and url:
            bits.append(f"[{label}]({url})")
        elif url:
            bits.append(url)
    return " · ".join(bits)


def _sorted_experience(entries: list[Any]) -> list[dict[str, Any]]:
    """Return non-empty entries sorted by end date desc, then start desc."""
    valid = [e for e in entries if isinstance(e, dict)]
    return sorted(
        valid,
        key=lambda e: (_sort_key(e.get("end")), _sort_key(e.get("start"))),
        reverse=True,
    )


def _sort_key(value: Any) -> str:
    """Sort YYYY-MM strings lexicographically; treat 'present' as far future."""
    text = str(value or "").strip().lower()
    if text == "present":
        return "9999-99"
    return text


def _render_experience_entry(entry: dict[str, Any]) -> str:
    role = str(entry.get("role") or "").strip()
    company = str(entry.get("company") or "").strip()
    heading_parts = [p for p in (role, company) if p]
    heading = " — ".join(heading_parts) if heading_parts else "(untitled role)"

    meta = _meta_line(entry)
    bullets = [str(b).strip() for b in entry.get("bullets") or [] if str(b).strip()]

    lines = [f"### {heading}"]
    if meta:
        lines.append(f"*{meta}*")
    lines.append("")
    if bullets:
        lines.extend(f"- {b}" for b in bullets)
    return "\n".join(lines) + "\n"


def _render_education_entry(entry: dict[str, Any]) -> str:
    degree = str(entry.get("degree") or "").strip()
    school = str(entry.get("school") or "").strip()
    heading_parts = [p for p in (degree, school) if p]
    heading = " — ".join(heading_parts) if heading_parts else "(untitled)"

    meta = _meta_line(entry)
    details = [str(d).strip() for d in entry.get("details") or [] if str(d).strip()]

    lines = [f"### {heading}"]
    if meta:
        lines.append(f"*{meta}*")
    lines.append("")
    if details:
        lines.extend(f"- {d}" for d in details)
    return "\n".join(lines) + "\n"


def _meta_line(entry: dict[str, Any]) -> str:
    start = str(entry.get("start") or "").strip()
    end = str(entry.get("end") or "").strip()
    location = str(entry.get("location") or "").strip()

    date_range = ""
    if start and end:
        date_range = f"{start} – {end}"
    elif start:
        date_range = start
    elif end:
        date_range = end

    bits = [b for b in (date_range, location) if b]
    return " · ".join(bits)


# --- AI tailoring ---


_LLM_SYSTEM = """\
You tailor resumes to specific job postings. The user provides their
master resume as YAML and a job posting. Produce a tailored resume in
markdown that emphasizes content relevant to the posting.

Rules:
- Use only content the user actually has. Do not invent experience,
  skills, education, or credentials.
- Reorder and rephrase bullets to surface the most JD-relevant work
  first. Mirror the posting's language when accurate.
- Drop bullets that are clearly irrelevant to keep the resume focused
  (~one page, roughly 400-600 words of content).
- Keep the standard resume sections: header (name + contact), Objective
  (if present), Experience, Education, then any extras the user has.
- Output only the tailored resume as markdown. No preamble, no
  commentary, no code fences around the whole document.\
"""


_LLM_MAX_TOKENS = 2500


def render_tailored(
    resume: dict[str, Any],
    opp: opp_core.Opportunity,
    config: llm.LLMConfig,
) -> str:
    """Ask the configured LLM to tailor `resume` for `opp`. Returns markdown.

    Raises :class:`llm.LLMError` on network/API failures.
    """
    prompt = _build_llm_prompt(resume, opp)
    raw = llm.complete(
        config,
        system=_LLM_SYSTEM,
        user=prompt,
        max_tokens=_LLM_MAX_TOKENS,
    )
    return _strip_code_fences(raw).rstrip() + "\n"


def _build_llm_prompt(
    resume: dict[str, Any], opp: opp_core.Opportunity
) -> str:
    resume_yaml = yaml.safe_dump(
        resume or {}, sort_keys=False, allow_unicode=True
    ).strip()
    frontmatter_yaml = yaml.safe_dump(
        dict(opp.frontmatter or {}), sort_keys=False, allow_unicode=True
    ).strip()
    body = (opp.body or "").strip() or "(no description in body)"
    target = str(resume.get("target") or "").strip()

    sections = [
        "## Master resume\n```yaml\n" + resume_yaml + "\n```",
    ]
    if target:
        sections.append("## User's career target (planning context)\n" + target)
    sections.append(
        "## Opportunity frontmatter\n```yaml\n" + frontmatter_yaml + "\n```"
    )
    sections.append("## Opportunity body\n" + body)
    sections.append(
        "Produce the tailored resume in markdown now. Headers: H1 for the "
        "name, H2 for section titles, H3 for individual roles/degrees."
    )
    return "\n\n".join(sections)


def _strip_code_fences(text: str) -> str:
    """Remove an outer ```markdown ... ``` wrapper if the model added one."""
    stripped = text.strip()
    if stripped.startswith("```"):
        first_newline = stripped.find("\n")
        if first_newline != -1:
            stripped = stripped[first_newline + 1 :]
        if stripped.endswith("```"):
            stripped = stripped[: -3]
    return stripped.strip()
