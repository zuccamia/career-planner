"""Tests for the opportunities module and the `career opportunity` CLI."""

from __future__ import annotations

from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import opportunity as opportunity_cmd
from career_planner.core import opportunities as opp_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})


# --- core/opportunities.py ---


def test_slugify_strips_punctuation_and_lowercases() -> None:
    assert opp_core.slugify("Staff Engineer at Acme Corp!") == "staff-engineer-at-acme-corp"
    assert opp_core.slugify("  Hello,  World  ") == "hello-world"


def test_slugify_falls_back_when_no_alnum() -> None:
    assert opp_core.slugify("!!!") == "opportunity"
    assert opp_core.slugify("") == "opportunity"


def test_unique_slug_appends_suffix_when_taken(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    (ws / "opportunities").mkdir(exist_ok=True)
    (ws / "opportunities" / "staff-eng.md").write_text("---\n---\n")
    (ws / "opportunities" / "staff-eng-2.md").write_text("---\n---\n")
    assert opp_core.unique_slug(ws, "staff-eng") == "staff-eng-3"


def test_create_opportunity_writes_file_with_frontmatter(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = opp_core.create_opportunity(
        ws, title="Staff Engineer at Acme", created=date(2026, 5, 11)
    )
    assert path.exists()
    assert path.parent == ws / "opportunities"
    assert path.stem == "staff-engineer-at-acme"

    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    assert front["title"] == "Staff Engineer at Acme"
    assert front["status"] == "active"
    assert front["created"] == date(2026, 5, 11)
    # Notion-export fields are present in the template (empty until filled in)
    assert "date_posted" in front
    assert "applied_at" in front
    assert front.get("attachments") == []
    assert "## Description" in body


def test_create_opportunity_dedupes_slug(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    first = opp_core.create_opportunity(ws, title="Senior Eng at Acme")
    second = opp_core.create_opportunity(ws, title="Senior Eng at Acme")
    assert first.stem == "senior-eng-at-acme"
    assert second.stem == "senior-eng-at-acme-2"


def test_create_opportunity_merges_extra_fields(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = opp_core.create_opportunity(
        ws,
        title="Engineer",
        url="https://example.com/jobs/1",
        extra={"company": "Globex", "location": "Remote"},
    )
    front, _body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    assert front["company"] == "Globex"
    assert front["location"] == "Remote"
    assert front["url"] == "https://example.com/jobs/1"


def test_parse_markdown_handles_missing_frontmatter() -> None:
    front, body = opp_core.parse_markdown("Just a body, no header.\n")
    assert front == {}
    assert "Just a body" in body


def test_parse_markdown_round_trip() -> None:
    text = "---\ntitle: T\nstatus: active\n---\n## Body\n\ncontent\n"
    front, body = opp_core.parse_markdown(text)
    assert front == {"title": "T", "status": "active"}
    assert body.startswith("## Body")

    rebuilt = opp_core.serialize_markdown(front, body)
    front2, body2 = opp_core.parse_markdown(rebuilt)
    assert front2 == front
    assert body2.strip() == body.strip()


def test_list_opportunities_filters_by_status(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    a = opp_core.create_opportunity(ws, title="A Job")
    b = opp_core.create_opportunity(ws, title="B Job")
    # Mutate B's status to applied
    text = b.read_text(encoding="utf-8")
    front, body = opp_core.parse_markdown(text)
    front["status"] = "applied"
    b.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")

    all_opps = opp_core.list_opportunities(ws)
    assert {o.slug for o in all_opps} == {a.stem, b.stem}

    active = opp_core.list_opportunities(ws, status="active")
    assert [o.slug for o in active] == [a.stem]

    applied = opp_core.list_opportunities(ws, status="applied")
    assert [o.slug for o in applied] == [b.stem]


def test_find_opportunity_prefers_exact_slug(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Senior Engineer")
    opp_core.create_opportunity(ws, title="Senior Engineer at Acme")

    exact = opp_core.find_opportunity(ws, "senior-engineer")
    assert [o.slug for o in exact] == ["senior-engineer"]

    partial = opp_core.find_opportunity(ws, "engineer")
    assert {o.slug for o in partial} == {
        "senior-engineer",
        "senior-engineer-at-acme",
    }


def test_find_opportunity_strips_md_suffix(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Lead Eng")
    matches = opp_core.find_opportunity(ws, "lead-eng.md")
    assert [o.slug for o in matches] == ["lead-eng"]


def test_extract_title_prefers_og_title() -> None:
    html = (
        '<html><head><title>Some Site</title>'
        '<meta property="og:title" content="Senior Engineer — Acme">'
        '</head></html>'
    )
    assert opp_core.extract_title_from_html(html) == "Senior Engineer — Acme"


def test_extract_title_falls_back_to_title_tag() -> None:
    html = "<html><head><title>  Staff Engineer at Globex  </title></head></html>"
    assert opp_core.extract_title_from_html(html) == "Staff Engineer at Globex"


def test_extract_title_decodes_entities() -> None:
    html = "<title>R&amp;D Lead</title>"
    assert opp_core.extract_title_from_html(html) == "R&D Lead"


def test_extract_title_returns_empty_when_none_found() -> None:
    assert opp_core.extract_title_from_html("<html><body>No title</body></html>") == ""


# --- structured (JSON-LD) extraction ---


def _wrap_jsonld(payload: str) -> str:
    return (
        '<html><head><script type="application/ld+json">'
        f"{payload}"
        "</script></head></html>"
    )


def test_extract_job_posting_from_jsonld_full() -> None:
    payload = """
    {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      "title": "Senior Software Engineer",
      "hiringOrganization": {"@type": "Organization", "name": "Microsoft"},
      "jobLocation": {
        "@type": "Place",
        "address": {
          "@type": "PostalAddress",
          "addressLocality": "Redmond",
          "addressRegion": "WA",
          "addressCountry": {"@type": "Country", "name": "US"}
        }
      },
      "datePosted": "2026-05-07T13:32:39Z",
      "validThrough": "2026-11-03T13:32:39",
      "employmentType": "FULL_TIME",
      "description": "<p>Build great things.</p><ul><li>Ship features</li></ul>"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["title"] == "Senior Software Engineer at Microsoft"
    assert result["role"] == "Senior Software Engineer"
    assert result["company"] == "Microsoft"
    assert result["location"] == "Redmond, WA, US"
    assert result["date_posted"] == "2026-05-07"
    assert result["deadline"] == "2026-11-03"
    assert "Build great things" in result["description"]
    assert "- Ship features" in result["description"]
    # employmentType is FULL_TIME, not TELECOMMUTE — work_type should be absent.
    assert "work_type" not in result


def test_extract_job_posting_dedupes_country_in_region() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "jobLocation": {"@type": "Place", "address": {
        "addressLocality": "Redmond",
        "addressRegion": "WA,US",
        "addressCountry": "US"
      }}
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["location"] == "Redmond, WA,US"


def test_extract_job_posting_handles_telecommute() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Remote Engineer",
      "jobLocationType": "TELECOMMUTE"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["work_type"] == "remote"


def test_extract_job_posting_handles_type_array() -> None:
    payload = """
    {
      "@type": ["JobPosting", "WebPage"],
      "title": "Data Engineer",
      "hiringOrganization": "Acme"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["role"] == "Data Engineer"
    assert result["company"] == "Acme"


def test_extract_job_posting_walks_graph() -> None:
    payload = """
    {
      "@context": "https://schema.org",
      "@graph": [
        {"@type": "WebPage", "name": "Careers"},
        {"@type": "JobPosting", "title": "ML Researcher",
         "hiringOrganization": {"name": "Globex"}}
      ]
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["title"] == "ML Researcher at Globex"


def test_extract_job_posting_salary_range() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": "USD",
        "value": {"@type": "QuantitativeValue", "minValue": 150000, "maxValue": 200000}
      }
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 150000
    assert result["salary_max"] == 200000
    assert result["salary_currency"] == "USD"


def test_extract_job_posting_salary_single_value() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": "EUR",
        "value": {"value": 90000}
      }
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 90000
    assert result["salary_max"] == 90000
    assert result["salary_currency"] == "EUR"


def test_extract_job_posting_skills_string() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skills": "Python, AWS; Kubernetes"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python", "AWS", "Kubernetes"]


def test_extract_job_posting_skills_list_of_strings() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skills": ["Python", "AWS", "Kubernetes"]
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python", "AWS", "Kubernetes"]


def test_extract_job_posting_skills_defined_terms() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skills": [
        {"@type": "DefinedTerm", "name": "Python"},
        {"@type": "DefinedTerm", "name": "AWS"}
      ]
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python", "AWS"]


def test_extract_job_posting_skills_single_defined_term() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skills": {"@type": "DefinedTerm", "name": "Python"}
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python"]


def test_extract_job_posting_skills_falls_back_to_skills_required() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skillsRequired": "Python\\nAWS\\nKubernetes"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python", "AWS", "Kubernetes"]


def test_extract_job_posting_skills_dedupes_preserving_order() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "skills": ["Python", "python", "AWS", "PYTHON"]
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["required_skills"] == ["Python", "AWS"]


def test_extract_job_posting_skills_absent_when_no_field() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer"}
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert "required_skills" not in result


def test_extract_job_posting_ignores_malformed_jsonld() -> None:
    html_doc = (
        '<html><head>'
        '<script type="application/ld+json">{ not valid json }</script>'
        '<meta property="og:title" content="Fallback Title">'
        '</head></html>'
    )
    result = opp_core.extract_job_posting(html_doc)
    assert result["title"] == "Fallback Title"


def test_extract_job_posting_skips_non_job_jsonld() -> None:
    payload = """
    {"@type": "Organization", "name": "Acme"}
    """
    html_doc = (
        _wrap_jsonld(payload)
        + '<meta property="og:title" content="Some Role at Acme">'
    )
    result = opp_core.extract_job_posting(html_doc)
    # No JobPosting node → falls through to OG.
    assert result["title"] == "Some Role at Acme"


def test_extract_job_posting_og_fallback_includes_company_and_description() -> None:
    html_doc = (
        '<html><head>'
        '<meta property="og:title" content="Senior Engineer">'
        '<meta property="og:site_name" content="Globex">'
        '<meta property="og:description" content="Build great stuff.">'
        '</head></html>'
    )
    result = opp_core.extract_job_posting(html_doc)
    assert result["title"] == "Senior Engineer"
    assert result["company"] == "Globex"
    assert result["description"] == "Build great stuff."


# --- create_opportunity body_description injection ---


def test_create_opportunity_injects_body_description(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = opp_core.create_opportunity(
        ws,
        title="Engineer at Acme",
        body_description="Build great things.\n\n- Item one\n- Item two",
    )
    text = path.read_text(encoding="utf-8")
    assert "## Description\n\nBuild great things." in text
    # The Pros heading still appears later in the body.
    assert "## Pros" in text


# --- CLI --url uses richer JSON-LD extraction ---


def test_cli_opportunity_add_with_jsonld_url_populates_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    payload = """
    <html><head><script type="application/ld+json">
    {
      "@type": "JobPosting",
      "title": "Senior Software Engineer",
      "hiringOrganization": {"name": "Microsoft"},
      "jobLocation": {"@type": "Place",
        "address": {"addressLocality": "Redmond", "addressRegion": "WA",
                    "addressCountry": "US"}},
      "datePosted": "2026-05-07",
      "validThrough": "2026-11-03",
      "description": "<p>Build intelligent infrastructure.</p>"
    }
    </script></head></html>
    """
    with patch.object(opportunity_cmd.opp_core, "fetch_url", return_value=payload):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "--url",
                "https://example.com/jobs/1",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output

    target = ws / "opportunities" / "senior-software-engineer-at-microsoft.md"
    assert target.exists()
    front, body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["title"] == "Senior Software Engineer at Microsoft"
    assert front["role"] == "Senior Software Engineer"
    assert front["company"] == "Microsoft"
    assert front["location"] == "Redmond, WA, US"
    assert str(front["date_posted"]) == "2026-05-07"
    assert str(front["deadline"]) == "2026-11-03"
    assert "Build intelligent infrastructure" in body


def test_cli_opportunity_add_with_jsonld_skills_writes_required_skills(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    payload = """
    <script type="application/ld+json">
    {
      "@type": "JobPosting",
      "title": "Senior Engineer",
      "hiringOrganization": {"name": "Acme"},
      "skills": ["Python", "AWS", "Kubernetes"]
    }
    </script>
    """
    with patch.object(opportunity_cmd.opp_core, "fetch_url", return_value=payload):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "--url",
                "https://example.com/jobs/1",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output

    target = ws / "opportunities" / "senior-engineer-at-acme.md"
    front, _body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["required_skills"] == ["Python", "AWS", "Kubernetes"]


def test_cli_opportunity_add_with_explicit_title_keeps_extracted_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    payload = """
    <script type="application/ld+json">
    {"@type": "JobPosting", "title": "Generic Title",
     "hiringOrganization": {"name": "Acme"},
     "jobLocation": {"address": {"addressLocality": "Remote"}}}
    </script>
    """
    with patch.object(opportunity_cmd.opp_core, "fetch_url", return_value=payload):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "My Override",
                "--url",
                "https://example.com/x",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output

    target = ws / "opportunities" / "my-override.md"
    assert target.exists()
    front, _body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["title"] == "My Override"
    # role is suppressed when the user overrides the title so the two stay aligned
    assert front.get("role", "") == ""
    # but company/location still come through.
    assert front["company"] == "Acme"
    assert front["location"] == "Remote"


# --- CLI: career opportunity add/list/show ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_opportunity_add_creates_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(
        app,
        ["opportunity", "add", "Staff Engineer at Acme Corp", "--no-editor"],
    )
    assert result.exit_code == 0, result.output

    target = ws / "opportunities" / "staff-engineer-at-acme-corp.md"
    assert target.exists()

    front, body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["title"] == "Staff Engineer at Acme Corp"
    assert front["status"] == "active"
    assert "## Description" in body
    assert "staff-engineer-at-acme-corp" in result.output


def test_cli_opportunity_add_opens_editor_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    captured: list[Path] = []

    def fake_open(file_path: Path, editor: str) -> int:
        captured.append(file_path)
        return 0

    with patch.object(
        opportunity_cmd.profile_core, "open_in_editor", side_effect=fake_open
    ):
        result = runner.invoke(app, ["opportunity", "add", "A Role"])

    assert result.exit_code == 0, result.output
    assert len(captured) == 1
    assert captured[0] == ws / "opportunities" / "a-role.md"


def test_cli_opportunity_add_handles_missing_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(
        opportunity_cmd.profile_core,
        "open_in_editor",
        side_effect=FileNotFoundError("missing"),
    ):
        result = runner.invoke(app, ["opportunity", "add", "A Role"])

    # The file is created even when the editor can't be launched.
    assert result.exit_code == 0
    assert "editor not found" in result.output.lower()


def test_cli_opportunity_add_requires_title_or_url(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["opportunity", "add", "--no-editor"])
    assert result.exit_code == 1
    assert "title" in result.output.lower() or "url" in result.output.lower()


def test_cli_opportunity_add_with_url_uses_extracted_title(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    html_body = (
        '<html><head>'
        '<meta property="og:title" content="Senior Engineer at Globex">'
        "<title>Globex Careers</title></head></html>"
    )
    with patch.object(opportunity_cmd.opp_core, "fetch_url", return_value=html_body):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "--url",
                "https://example.com/jobs/1",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output

    target = ws / "opportunities" / "senior-engineer-at-globex.md"
    assert target.exists()
    front, _body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["title"] == "Senior Engineer at Globex"
    assert front["url"] == "https://example.com/jobs/1"


def test_cli_opportunity_add_with_url_falls_back_on_fetch_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    with patch.object(
        opportunity_cmd.opp_core,
        "fetch_url",
        side_effect=RuntimeError("connection refused"),
    ):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "--url",
                "https://example.com/jobs/2",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output
    assert "could not fetch" in result.output.lower()

    # The URL itself is used as the title when no extraction is possible.
    files = list((ws / "opportunities").glob("*.md"))
    assert len(files) == 1


def test_cli_opportunity_add_with_url_and_explicit_title(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    with patch.object(
        opportunity_cmd.opp_core,
        "fetch_url",
        return_value="<title>Auto Title</title>",
    ):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "add",
                "My Custom Title",
                "--url",
                "https://example.com/x",
                "--no-editor",
            ],
        )
    assert result.exit_code == 0, result.output
    target = ws / "opportunities" / "my-custom-title.md"
    assert target.exists()
    front, _ = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["title"] == "My Custom Title"
    assert front["url"] == "https://example.com/x"


def test_cli_opportunity_list_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["opportunity", "list"])
    assert result.exit_code == 0, result.output
    assert "no opportunities" in result.output.lower()


def test_cli_opportunity_list_renders_table(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(
        app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"]
    )
    runner.invoke(
        app, ["opportunity", "add", "Staff Engineer at Globex", "--no-editor"]
    )
    result = runner.invoke(app, ["opportunity", "list"])
    assert result.exit_code == 0, result.output
    assert "senior-engineer-at-acme" in result.output
    assert "staff-engineer-at-globex" in result.output


def test_cli_opportunity_list_filters_by_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "A Job", "--no-editor"])
    runner.invoke(app, ["opportunity", "add", "B Job", "--no-editor"])
    path = ws / "opportunities" / "b-job.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["status"] = "applied"
    path.write_text(
        opp_core.serialize_markdown(front, body), encoding="utf-8"
    )

    active = runner.invoke(app, ["opportunity", "list", "--status", "active"])
    assert "a-job" in active.output
    assert "b-job" not in active.output

    applied = runner.invoke(app, ["opportunity", "list", "--status", "applied"])
    assert "b-job" in applied.output
    assert "a-job" not in applied.output


def test_cli_opportunity_list_rejects_unknown_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["opportunity", "list", "--status", "bogus"])
    assert result.exit_code == 1
    assert "unknown status" in result.output.lower()


def test_cli_opportunity_show_prints_details(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])

    # Enrich the file so the renderer has something to print.
    path = ws / "opportunities" / "senior-engineer-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["company"] = "Acme Corp"
    front["role"] = "Senior Engineer"
    front["location"] = "Remote"
    front["salary_min"] = 150000
    front["salary_max"] = 180000
    body = body + "\n## Description\n\nExciting role.\n"
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")

    result = runner.invoke(app, ["opportunity", "show", "senior-engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Senior Engineer at Acme" in result.output
    assert "Acme Corp" in result.output
    assert "Remote" in result.output
    assert "150000" in result.output
    assert "Exciting role" in result.output


def test_cli_opportunity_show_renders_notion_export_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    path = ws / "opportunities" / "senior-engineer-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["date_posted"] = "2026-05-01"
    front["applied_at"] = "2026-05-08"
    front["attachments"] = ["resume-acme-v1.pdf", "cover-letter-acme.pdf"]
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")

    result = runner.invoke(app, ["opportunity", "show", "senior-engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "2026-05-01" in result.output
    assert "2026-05-08" in result.output
    assert "resume-acme-v1.pdf" in result.output
    assert "cover-letter-acme.pdf" in result.output


def test_cli_opportunity_show_substring_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    result = runner.invoke(app, ["opportunity", "show", "acme"])
    assert result.exit_code == 0, result.output
    assert "Senior Engineer at Acme" in result.output


def test_cli_opportunity_show_missing_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["opportunity", "show", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_opportunity_show_disambiguates_multiple_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    runner.invoke(
        app, ["opportunity", "add", "Senior Engineer at Globex", "--no-editor"]
    )
    result = runner.invoke(app, ["opportunity", "show", "engineer"], input="1\n")
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


def test_cli_opportunity_commands_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    add_res = runner.invoke(app, ["opportunity", "add", "X", "--no-editor"])
    list_res = runner.invoke(app, ["opportunity", "list"])
    show_res = runner.invoke(app, ["opportunity", "show", "x"])
    assert add_res.exit_code == 2
    assert list_res.exit_code == 2
    assert show_res.exit_code == 2
