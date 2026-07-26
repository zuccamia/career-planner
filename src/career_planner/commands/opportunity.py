"""`career opportunity` — manage tracked career opportunities."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from career_planner.core import llm as llm_core
from career_planner.core import opportunities as opp_core
from career_planner.core.workspace import (
    load_config,
    open_in_editor,
    require_workspace,
    resolve_editor,
)
from career_planner.i18n import _

console = Console()


def add(
    title: str | None = None,
    url: str | None = None,
    open_editor: bool = True,
    parse: bool = False,
) -> None:
    """Create an opportunity file and optionally open it in the editor.

    Either ``title`` or ``url`` must be provided. When only ``url`` is given,
    the page is fetched and ``<title>`` is used as the opportunity title.
    ``parse`` adds an LLM gap-filling pass on top of the deterministic
    extractor; it requires an LLM provider in ``config.yml``.
    """
    if not title and not url:
        console.print(
            _("Provide a title or use --url to import from a job posting."),
            style="red",
        )
        raise typer.Exit(1)

    if parse and not url:
        console.print(
            _("LLM parsing requires a URL to fetch."),
            style="red",
        )
        raise typer.Exit(1)

    workspace = require_workspace()
    resolved_title, extra, body_description = _resolve_title_and_extras(
        title, url, parse=parse, workspace=workspace
    )

    target = opp_core.create_opportunity(
        workspace,
        title=resolved_title,
        url=url or "",
        extra=extra,
        body_description=body_description,
    )

    console.print(
        Panel(
            "\n".join(
                [
                    _("Title: {t}").format(t=resolved_title),
                    _("File: {p}").format(p=target),
                    _("Slug: {s}").format(s=target.stem),
                ]
            ),
            title=_("Opportunity created"),
            border_style="green",
        )
    )

    if open_editor:
        _open_in_editor(workspace, target)


def list_opportunities(status: str | None = None) -> None:
    """List tracked opportunities as a Rich table."""
    workspace = require_workspace()

    opps = opp_core.list_opportunities(workspace, status=status)
    if not opps:
        if status:
            console.print(
                _("No opportunities with status '{s}'.").format(s=status),
                style="yellow",
            )
        else:
            console.print(
                _(
                    "No opportunities tracked yet. "
                    "Add one with `career opportunity add \"<title>\"`."
                ),
                style="yellow",
            )
        return

    title = (
        _("Opportunities ({n}, status={s})").format(n=len(opps), s=status)
        if status
        else _("Opportunities ({n})").format(n=len(opps))
    )
    table = Table(title=title)
    table.add_column(_("Slug"), style="cyan")
    table.add_column(_("Title"))
    table.add_column(_("Company"))
    table.add_column(_("Status"), style="dim")
    table.add_column(_("Deadline"), style="dim")

    for opp in opps:
        table.add_row(
            opp.slug,
            opp.title,
            opp.company or "—",
            opp.status or "—",
            opp.deadline or "—",
        )
    console.print(table)


def show(opportunity: str) -> None:
    """Print the full details of a specific opportunity."""
    workspace = require_workspace()

    matches = opp_core.find_opportunity(workspace, opportunity)
    if not matches:
        console.print(
            _("No opportunity matching '{q}'.").format(q=opportunity),
            style="red",
        )
        raise typer.Exit(1)

    if len(matches) == 1:
        target = matches[0]
    else:
        console.print(_("Multiple opportunities match '{q}':").format(q=opportunity))
        for n, opp in enumerate(matches, 1):
            console.print(f"  {n}. {opp.slug} — {opp.title}")
        choice = typer.prompt(_("Pick a number (or 0 to cancel)"), type=int)
        if choice < 1 or choice > len(matches):
            console.print(_("Cancelled."), style="yellow")
            raise typer.Exit(1)
        target = matches[choice - 1]

    _render_opportunity(target)


# --- helpers ---


def _resolve_title_and_extras(
    title: str | None,
    url: str | None,
    *,
    parse: bool = False,
    workspace: Path | None = None,
) -> tuple[str, dict[str, Any], str]:
    """Resolve the opportunity title, frontmatter extras, and body description.

    When ``url`` is provided, the page is fetched and either:

    * ``parse=False`` — :func:`opp_core.extract_job_posting` pulls fields
      via JSON-LD → Open Graph → ``<title>``.
    * ``parse=True`` — :func:`opp_core.llm_extract_posting` does a single
      LLM pass over the stripped page text. On any LLM failure the path
      falls back to :func:`opp_core.extract_job_posting` with a warning,
      so the user always gets a populated file.
    """
    extra: dict[str, Any] = {}
    body_description = ""
    if not url:
        return title or "", extra, body_description

    extracted: dict[str, Any] = {}
    page = ""
    try:
        page = opp_core.fetch_url(url)
    except Exception as exc:
        console.print(
            _("Could not fetch {url}: {err}").format(url=url, err=exc),
            style="yellow",
        )

    if page:
        if parse and workspace is not None:
            extracted = _llm_extract(workspace, page)
        else:
            extracted = opp_core.extract_job_posting(page)

    extracted_title = str(extracted.pop("title", "") or "")
    body_description = str(extracted.pop("description", "") or "")

    # A user-supplied --title wins over what we pulled from the page; we still
    # keep the role/company/etc. fields the extractor found.
    if title:
        extracted.pop("role", None)

    extra.update(extracted)
    final_title = title or extracted_title or url
    return final_title, extra, body_description


def _llm_extract(workspace: Path, page: str) -> dict[str, Any]:
    """Run pure-LLM extraction; fall back to structured extraction on failure.

    Missing config is a hard error (exit 3, matching ``criteria check
    --reason``). Network, API, and JSON-parse failures fall back to
    :func:`opp_core.extract_job_posting` with a yellow warning so the
    file still gets useful content.
    """
    try:
        config = llm_core.load_config(workspace)
    except llm_core.LLMConfigError as exc:
        console.print(
            _(
                "'opportunity parse' needs an LLM provider in config.yml: {err}"
            ).format(err=exc),
            style="red",
        )
        raise typer.Exit(3) from None

    with console.status(_("Extracting with {model}…").format(model=config.model)):
        try:
            return opp_core.llm_extract_posting(page, config)
        except (llm_core.LLMError, ValueError) as exc:
            console.print(
                _(
                    "LLM extraction failed ({err}); falling back to "
                    "structured extraction."
                ).format(err=exc),
                style="yellow",
            )
            return opp_core.extract_job_posting(page)

    for key, value in enrichment.items():
        if not extracted.get(key):
            extracted[key] = value


def _open_in_editor(workspace: Path, target: Path) -> None:
    """Open `target` in the user's editor; print a hint on failure."""
    editor = resolve_editor(load_config(workspace))
    try:
        rc = open_in_editor(target, editor)
    except FileNotFoundError:
        console.print(
            _(
                "Editor not found: '{ed}'. Edit the file manually at:\n{path}"
            ).format(ed=editor, path=target),
            style="yellow",
        )
        return
    if rc != 0:
        console.print(
            _("Editor exited with status {n}.").format(n=rc),
            style="yellow",
        )


def _render_opportunity(opp: opp_core.Opportunity) -> None:
    """Print an opportunity as a header panel plus rendered body."""
    front = opp.frontmatter

    header_lines = [
        _("Slug: {s}").format(s=opp.slug),
        _("Title: {t}").format(t=opp.title),
        _("Status: {s}").format(s=opp.status or "—"),
    ]
    role = opp.role
    company = opp.company
    if role or company:
        header_lines.append(
            _("Role: {role} @ {company}").format(
                role=role or "—", company=company or "—"
            )
        )
    if opp.location:
        header_lines.append(_("Location: {v}").format(v=opp.location))
    work_type = front.get("work_type")
    if work_type:
        header_lines.append(_("Work type: {v}").format(v=work_type))

    salary = _format_salary(front)
    if salary:
        header_lines.append(_("Salary: {v}").format(v=salary))

    date_posted = front.get("date_posted")
    if date_posted:
        header_lines.append(_("Posted: {v}").format(v=date_posted))

    if opp.deadline:
        header_lines.append(_("Deadline: {v}").format(v=opp.deadline))

    applied_at = front.get("applied_at")
    if applied_at:
        header_lines.append(_("Applied: {v}").format(v=applied_at))

    url = front.get("url")
    if url:
        header_lines.append(_("URL: {v}").format(v=url))

    attachments = front.get("attachments") or []
    if isinstance(attachments, list) and attachments:
        header_lines.append(
            _("Attachments: {v}").format(
                v=", ".join(str(a) for a in attachments)
            )
        )

    skills = front.get("required_skills") or []
    if isinstance(skills, list) and skills:
        header_lines.append(
            _("Required skills: {v}").format(
                v=", ".join(str(s) for s in skills)
            )
        )

    console.print(
        Panel(
            "\n".join(header_lines),
            title=_("Opportunity"),
            border_style="cyan",
        )
    )

    body = (opp.body or "").strip()
    if body:
        console.print(Markdown(body))


def _format_salary(front: dict[str, Any]) -> str:
    """Format salary fields like ``150000–180000 USD`` (omit empty pieces)."""
    lo = front.get("salary_min")
    hi = front.get("salary_max")
    currency = front.get("salary_currency") or ""
    if lo in (None, "") and hi in (None, ""):
        return ""
    lo_s = "" if lo in (None, "") else str(lo)
    hi_s = "" if hi in (None, "") else str(hi)
    if lo_s and hi_s:
        amount = f"{lo_s}–{hi_s}"
    else:
        amount = lo_s or hi_s
    return f"{amount} {currency}".strip()
