"""Tests for the opportunities module and the `career opportunity` CLI."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import _common as common_cmd
from career_planner.commands import opportunity as opportunity_cmd
from career_planner.core import criteria as criteria_core
from career_planner.core import llm as llm_core
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


def test_extract_job_posting_infers_salary_from_description() -> None:
    # JSON-LD lacks baseSalary, but the description prose carries it — a
    # common shape on ATSes (Eightfold, Workday) that don't fill in the
    # structured field.
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "description": "<p>USD $150,000 - $200,000 per year plus benefits.</p>"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 150000
    assert result["salary_max"] == 200000
    assert result["salary_currency"] == "USD"


def test_extract_job_posting_does_not_override_structured_salary() -> None:
    # When JSON-LD already has baseSalary, body-text inference must not
    # clobber it even if the description happens to mention other numbers.
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "baseSalary": {
        "@type": "MonetaryAmount",
        "currency": "USD",
        "value": {"minValue": 120000, "maxValue": 140000}
      },
      "description": "<p>The role pays $150,000 - $200,000.</p>"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 120000
    assert result["salary_max"] == 140000


def test_extract_job_posting_infers_work_type_from_description() -> None:
    payload = """
    {
      "@type": "JobPosting",
      "title": "Engineer",
      "description": "<p>This role is fully remote.</p>"
    }
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["work_type"] == "remote"


def test_html_to_text_strips_script_and_style_content() -> None:
    html_doc = (
        "<div>Hello"
        "<script>var secret = {pay: 1234};</script>"
        "<style>body { color: red; }</style>"
        " world</div>"
    )
    assert opp_core._html_to_text(html_doc) == "Hello world"


# --- Eightfold ATS detour ---


@pytest.mark.parametrize(
    "url,expected",
    [
        (
            "https://apply.careers.microsoft.com/careers?pid=1970393556752618"
            "&hl=en",
            "1970393556752618",
        ),
        (
            "https://apply.careers.microsoft.com/careers/job/1970393556752618",
            "1970393556752618",
        ),
        (
            "https://acme-corp.eightfold.ai/careers?pid=42",
            "42",
        ),
        (
            "https://jobs.example.com/listing?pid=42",
            "",
        ),
        (
            "https://apply.careers.microsoft.com/careers?query=engineer",
            "",
        ),
    ],
)
def test_eightfold_pid_detects_supported_url_shapes(url: str, expected: str) -> None:
    assert opp_core._eightfold_pid(url) == expected


def test_company_from_eightfold_host() -> None:
    f = opp_core._company_from_eightfold_host
    assert f("https://apply.careers.microsoft.com/careers?pid=1") == "Microsoft"
    assert (
        f("https://apply.careers.bristol-myers-squibb.com/careers?pid=1")
        == "Bristol Myers Squibb"
    )
    assert f("https://acme-corp.eightfold.ai/careers?pid=1") == "Acme Corp"
    assert f("https://example.com/careers") == ""


def _eightfold_payload(**overrides: Any) -> dict[str, Any]:
    """Build a minimal Eightfold API payload, with overridable fields."""
    base = {
        "id": 1970393556752618,
        "name": "Teams Copilot Software Engineer",
        "location": "United States, Washington, Redmond",
        "locations": ["United States, Washington, Redmond"],
        "job_description": (
            "<b>Overview</b><br><div>Build the next generation of Teams.</div>"
            "<br><br><p>Software Engineering IC3 - The typical base pay range "
            "for this role across the U.S. is USD $100,600 - $199,000 per "
            "year.</p>"
        ),
        "department": "Software Engineering",
        "business_unit": "Experiences + Devices",
        "t_create": 1770394659,
        "t_update": 1770403633,
        "location_flexibility": None,
        "work_location_option": None,
    }
    base.update(overrides)
    return base


def test_fetch_url_uses_eightfold_api_when_pid_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Eightfold detour should call /api/apply/v2/jobs/<pid> and produce
    a synthesized HTML document whose downstream extraction yields the
    salary, location, and date the SPA shell never carries."""
    payload = _eightfold_payload()
    captured: dict[str, str] = {}

    class _FakeResponse:
        def __init__(self, data: dict[str, Any]):
            self._data = data
            self.text = json.dumps(data)

        def raise_for_status(self) -> None: ...

        def json(self) -> dict[str, Any]:
            return self._data

    def fake_get(url: str, **kwargs: Any) -> _FakeResponse:
        captured["url"] = url
        return _FakeResponse(payload)

    import httpx

    monkeypatch.setattr(httpx, "get", fake_get)

    url = (
        "https://apply.careers.microsoft.com/careers?domain=microsoft.com"
        "&pid=1970393556752618&hl=en"
    )
    synth = opp_core.fetch_url(url)
    assert (
        captured["url"]
        == "https://apply.careers.microsoft.com/api/apply/v2/jobs/1970393556752618"
    )

    fields = opp_core.extract_job_posting(synth)
    assert fields["role"] == "Teams Copilot Software Engineer"
    assert fields["company"] == "Microsoft"
    assert "Redmond" in fields["location"]
    assert fields["date_posted"] == "2026-02-06"
    assert fields["salary_min"] == 100600
    assert fields["salary_max"] == 199000
    assert fields["salary_currency"] == "USD"
    assert "Build the next generation of Teams" in fields["description"]

    # The LLM path reads tag-stripped text and so needs the structured
    # fields rendered as visible body text — without them the LLM never
    # sees location/date_posted, which live only in the JSON-LD <script>.
    body_text = opp_core._html_to_text(synth)
    assert "Role: Teams Copilot Software Engineer" in body_text
    assert "Company: Microsoft" in body_text
    assert "Location: United States, Washington, Redmond" in body_text
    assert "Date posted: 2026-02-06" in body_text
    # Salary lives in the description prose, not the JSON. Without a
    # labeled line, the LLM tends to anchor on the labeled fields and
    # leave salary blank — surface the inference here too.
    assert "Salary: USD 100,600 - 199,000" in body_text


def test_fetch_url_eightfold_maps_remote_flexibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _eightfold_payload(location_flexibility="remoteGlobal")

    class _FakeResponse:
        def __init__(self, data: dict[str, Any]):
            self._data = data
            self.text = json.dumps(data)

        def raise_for_status(self) -> None: ...

        def json(self) -> dict[str, Any]:
            return self._data

    import httpx

    monkeypatch.setattr(httpx, "get", lambda url, **kw: _FakeResponse(payload))

    synth = opp_core.fetch_url(
        "https://apply.careers.microsoft.com/careers?pid=42"
    )
    assert opp_core.extract_job_posting(synth)["work_type"] == "remote"


def test_fetch_url_falls_back_to_html_when_eightfold_api_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failing API call must not break the add flow — we should fall
    back to the regular HTML fetch so the user still gets *something*."""
    calls: list[str] = []

    class _FailingResponse:
        def raise_for_status(self) -> None:
            import httpx

            raise httpx.HTTPStatusError(
                "boom", request=None, response=None  # type: ignore[arg-type]
            )

        def json(self) -> dict[str, Any]:
            return {}

        @property
        def text(self) -> str:
            return ""

    class _HtmlResponse:
        text = "<html><head><title>Backup</title></head></html>"

        def raise_for_status(self) -> None: ...

    def fake_get(url: str, **kwargs: Any) -> Any:
        calls.append(url)
        if "/api/apply/" in url:
            return _FailingResponse()
        return _HtmlResponse()

    import httpx

    monkeypatch.setattr(httpx, "get", fake_get)

    body = opp_core.fetch_url(
        "https://apply.careers.microsoft.com/careers?pid=42"
    )
    assert "Backup" in body
    assert any("/api/apply/" in u for u in calls)
    assert any("/api/apply/" not in u for u in calls)


# --- llm_extract_posting ---


def _fake_llm_config() -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def test_llm_extract_posting_returns_full_frontmatter_shape() -> None:
    captured: dict = {}

    def fake_complete(config, *, system, user, **kwargs):
        captured["user"] = user
        return (
            '{"title": "Senior Engineer at Acme", "role": "Senior Engineer", '
            '"company": "Acme", "location": "NYC", "work_type": "hybrid", '
            '"date_posted": "2026-05-01", "deadline": "2026-09-30", '
            '"salary_min": 150000, "salary_max": 200000, '
            '"salary_currency": "USD", '
            '"required_skills": ["Python", "AWS"], '
            '"description": "Build the platform."}'
        )

    with patch.object(llm_core, "complete", side_effect=fake_complete):
        out = opp_core.llm_extract_posting(
            "<p>Acme is hiring a Senior Engineer.</p>",
            _fake_llm_config(),
        )

    assert out == {
        "title": "Senior Engineer at Acme",
        "role": "Senior Engineer",
        "company": "Acme",
        "location": "NYC",
        "work_type": "hybrid",
        "date_posted": "2026-05-01",
        "deadline": "2026-09-30",
        "salary_min": 150_000,
        "salary_max": 200_000,
        "salary_currency": "USD",
        "required_skills": ["Python", "AWS"],
        "description": "Build the platform.",
    }
    # The prompt should include all the field names we expect the LLM to fill.
    for key in (
        "title",
        "role",
        "company",
        "location",
        "work_type",
        "salary_min",
        "salary_currency",
        "required_skills",
        "description",
    ):
        assert key in captured["user"]


def test_llm_extract_posting_drops_nulls_and_invalid_values() -> None:
    def fake_complete(*args, **kwargs):
        return (
            '{"title": "Engineer at Acme", "role": "Engineer", '
            '"company": "Acme", "location": null, '
            '"work_type": "flexible", "date_posted": null, '
            '"deadline": "someday", "salary_min": null, "salary_max": null, '
            '"salary_currency": "dollars", "required_skills": [], '
            '"description": null}'
        )

    with patch.object(llm_core, "complete", side_effect=fake_complete):
        out = opp_core.llm_extract_posting("<p>...</p>", _fake_llm_config())

    assert out["title"] == "Engineer at Acme"
    assert out["role"] == "Engineer"
    assert out["company"] == "Acme"
    # Invalid work_type, malformed deadline, bad currency, null description
    # and the empty-skills list are all dropped.
    for key in (
        "location",
        "work_type",
        "date_posted",
        "deadline",
        "salary_currency",
        "salary_min",
        "salary_max",
        "required_skills",
        "description",
    ):
        assert key not in out


def test_llm_extract_posting_dedupes_skills_case_insensitive() -> None:
    def fake_complete(*args, **kwargs):
        return (
            '{"title": "Engineer at Acme", "role": "Engineer", '
            '"company": "Acme", '
            '"required_skills": ["Python", "python", "AWS", "aws", "Go"]}'
        )

    with patch.object(llm_core, "complete", side_effect=fake_complete):
        out = opp_core.llm_extract_posting("<p>...</p>", _fake_llm_config())

    assert out["required_skills"] == ["Python", "AWS", "Go"]


def test_llm_extract_posting_coerces_float_salary_to_int() -> None:
    def fake_complete(*args, **kwargs):
        return (
            '{"title": "Engineer at Acme", "role": "Engineer", '
            '"company": "Acme", '
            '"salary_min": 100000.0, "salary_max": 150000.5, '
            '"salary_currency": "USD"}'
        )

    with patch.object(llm_core, "complete", side_effect=fake_complete):
        out = opp_core.llm_extract_posting("<p>...</p>", _fake_llm_config())

    # 100000.0 → 100000 (integer-valued float is accepted); 150000.5 is
    # dropped because it can't be safely coerced to a clean integer.
    assert out["salary_min"] == 100_000
    assert "salary_max" not in out


def test_llm_extract_posting_raises_on_malformed_json() -> None:
    def fake_complete(*args, **kwargs):
        return "not json at all"

    with patch.object(llm_core, "complete", side_effect=fake_complete):
        with pytest.raises(llm_core.LLMAPIError):
            opp_core.llm_extract_posting("<p>...</p>", _fake_llm_config())


def test_llm_extract_posting_truncates_long_pages() -> None:
    captured: dict = {}

    def fake_complete(config, *, system, user, **kwargs):
        captured["user"] = user
        return '{"title": "X", "role": "Y", "company": "Z"}'

    long_body = "<p>" + ("lorem ipsum " * 10_000) + "</p>"
    with patch.object(llm_core, "complete", side_effect=fake_complete):
        opp_core.llm_extract_posting(
            long_body, _fake_llm_config(), max_chars=5_000
        )

    # The prompt body should be capped at max_chars; the surrounding system
    # instructions and field list add a small constant on top.
    assert len(captured["user"]) < 5_000 + 2_000


# --- body-text salary and work_type inference ---


def test_extract_salary_from_text_dollar_k_range() -> None:
    out = opp_core.extract_salary_from_text(
        "Salary: $150K-$200K + equity"
    )
    assert out == {"salary_min": 150_000, "salary_max": 200_000, "salary_currency": "USD"}


def test_extract_salary_from_text_comma_full_numbers() -> None:
    out = opp_core.extract_salary_from_text(
        "Base salary $150,000-$200,000 per year"
    )
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000
    assert out["salary_currency"] == "USD"


def test_extract_salary_from_text_shared_k_suffix() -> None:
    # "$150-200K" — the K applies to both bounds.
    out = opp_core.extract_salary_from_text("Range: $150-200K")
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000


def test_extract_salary_from_text_to_separator() -> None:
    out = opp_core.extract_salary_from_text("$150K to $200K")
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000


def test_extract_salary_from_text_en_dash() -> None:
    out = opp_core.extract_salary_from_text("$150K–$200K")
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000


def test_extract_salary_from_text_postfix_currency() -> None:
    out = opp_core.extract_salary_from_text("150,000-200,000 USD")
    assert out == {"salary_min": 150_000, "salary_max": 200_000, "salary_currency": "USD"}


def test_extract_salary_from_text_euro() -> None:
    out = opp_core.extract_salary_from_text("€80K-€100K base")
    assert out["salary_min"] == 80_000
    assert out["salary_max"] == 100_000
    assert out["salary_currency"] == "EUR"


def test_extract_salary_from_text_gbp_postfix() -> None:
    out = opp_core.extract_salary_from_text("70-90K GBP per annum")
    assert out["salary_min"] == 70_000
    assert out["salary_max"] == 90_000
    assert out["salary_currency"] == "GBP"


def test_extract_salary_from_text_returns_empty_when_absent() -> None:
    assert opp_core.extract_salary_from_text("No salary disclosed.") == {}
    assert opp_core.extract_salary_from_text("") == {}


def test_extract_salary_from_text_ignores_unrelated_numbers() -> None:
    # No currency mark, no postfix currency → skip.
    assert opp_core.extract_salary_from_text("Team of 5-10 engineers.") == {}


def test_extract_salary_from_text_first_match_wins() -> None:
    # If both a prefix-currency and postfix-currency range appear, the
    # prefix one is reported (it's the canonical posting format).
    out = opp_core.extract_salary_from_text(
        "Base $150K-$200K; previously 100-120K USD."
    )
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000


def test_extract_work_type_fully_remote() -> None:
    assert opp_core.extract_work_type_from_text("This is a fully remote role.") == "remote"
    assert opp_core.extract_work_type_from_text("100% remote position") == "remote"


def test_extract_work_type_remote_first_or_only() -> None:
    assert opp_core.extract_work_type_from_text("Remote-first team") == "remote"
    assert opp_core.extract_work_type_from_text("remote only role") == "remote"


def test_extract_work_type_work_from_home() -> None:
    assert (
        opp_core.extract_work_type_from_text("You can work from anywhere.")
        == "remote"
    )


def test_extract_work_type_in_person_five_days() -> None:
    assert (
        opp_core.extract_work_type_from_text("5 days a week in office")
        == "in-person"
    )
    assert (
        opp_core.extract_work_type_from_text("fully in-person team")
        == "in-person"
    )


def test_extract_work_type_hybrid_explicit() -> None:
    assert opp_core.extract_work_type_from_text("Hybrid schedule") == "hybrid"


def test_extract_work_type_hybrid_from_days() -> None:
    assert (
        opp_core.extract_work_type_from_text("3 days per week in office")
        == "hybrid"
    )


def test_extract_work_type_strong_signal_beats_soft() -> None:
    # "fully remote" earlier in the text should win over a later "hybrid".
    text = "This is a fully remote role; some teams are hybrid."
    assert opp_core.extract_work_type_from_text(text) == "remote"


def test_extract_work_type_returns_empty_when_ambiguous() -> None:
    # Bare "remote" or "remote-friendly" is too ambiguous — skip.
    assert opp_core.extract_work_type_from_text("Remote-friendly culture.") == ""
    assert opp_core.extract_work_type_from_text("") == ""


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
        common_cmd, "open_in_editor", side_effect=fake_open
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
        common_cmd,
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


# --- CLI: career opportunity parse <url> ---


def _write_llm_config(ws: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_PARSE_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_PARSE_TEST_KEY", "sk-fake")


def test_cli_opportunity_parse_writes_llm_fields_to_frontmatter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pure-AI extraction: the LLM returns the full field set in one shot,
    and the opportunity file is populated entirely from that response."""
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_llm_config(ws, monkeypatch)

    # The JSON-LD here is intentionally *wrong* compared to the LLM response
    # so we can prove the parse path no longer pre-extracts from JSON-LD.
    payload = """
    <html><body>
    <script type="application/ld+json">
    {"@type": "JobPosting", "title": "Stale JSON-LD Title",
     "hiringOrganization": {"name": "Stale Inc"}}
    </script>
    <p>Real posting text the LLM would actually read.</p>
    </body></html>
    """

    llm_response = (
        '{"title": "Senior Engineer at Globex", '
        '"role": "Senior Engineer", "company": "Globex", '
        '"location": "NYC", "work_type": "hybrid", '
        '"date_posted": "2026-05-01", "deadline": null, '
        '"salary_min": 180000, "salary_max": 220000, '
        '"salary_currency": "USD", '
        '"required_skills": ["Python", "Go"], '
        '"description": "Build the platform team."}'
    )

    with patch.object(
        opportunity_cmd.opp_core, "fetch_url", return_value=payload
    ), patch.object(llm_core, "complete", return_value=llm_response):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "parse",
                "https://example.com/jobs/x",
                "--no-editor",
            ],
        )

    assert result.exit_code == 0, result.output
    target = ws / "opportunities" / "senior-engineer-at-globex.md"
    front, body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    # All fields come from the LLM; JSON-LD is not consulted on the happy path.
    assert front["company"] == "Globex"
    assert front["role"] == "Senior Engineer"
    assert front["location"] == "NYC"
    assert front["work_type"] == "hybrid"
    assert front["required_skills"] == ["Python", "Go"]
    assert front["salary_min"] == 180_000
    assert front["salary_max"] == 220_000
    assert front["salary_currency"] == "USD"
    assert "Build the platform team." in body
    # The stale JSON-LD title/company are never written.
    assert "Stale" not in target.read_text(encoding="utf-8")


def test_cli_opportunity_parse_missing_llm_config_exits_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    # No llm block in config.yml (the default from `career init`).
    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Role",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )
    with patch.object(
        opportunity_cmd.opp_core, "fetch_url", return_value=payload
    ):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "parse",
                "https://example.com/x",
                "--no-editor",
            ],
        )
    assert result.exit_code == 3, result.output
    assert "config.yml" in result.output
    # The opportunity file should not have been written.
    assert not list((ws / "opportunities").glob("*.md"))


def test_cli_opportunity_parse_llm_failure_falls_back_to_structured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An LLM API error during parse should warn and fall back to the
    deterministic structured extractor so the file still has useful fields."""
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_llm_config(ws, monkeypatch)

    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Senior Engineer",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )

    with patch.object(
        opportunity_cmd.opp_core, "fetch_url", return_value=payload
    ), patch.object(
        llm_core, "complete", side_effect=llm_core.LLMAPIError("HTTP 500")
    ):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "parse",
                "https://example.com/x",
                "--no-editor",
            ],
        )

    assert result.exit_code == 0, result.output
    assert "extraction failed" in result.output.lower()
    target = ws / "opportunities" / "senior-engineer-at-acme.md"
    assert target.exists()
    front, _body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    # Fields come from the JSON-LD fallback path.
    assert front["company"] == "Acme"
    assert front["role"] == "Senior Engineer"


def test_cli_opportunity_parse_malformed_json_falls_back_to_structured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_llm_config(ws, monkeypatch)

    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Engineer",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )

    with patch.object(
        opportunity_cmd.opp_core, "fetch_url", return_value=payload
    ), patch.object(
        llm_core, "complete", return_value="this is not json"
    ):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "parse",
                "https://example.com/x",
                "--no-editor",
            ],
        )

    assert result.exit_code == 0, result.output
    assert "extraction failed" in result.output.lower()
    target = ws / "opportunities" / "engineer-at-acme.md"
    assert target.exists()
    front, _body = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    assert front["company"] == "Acme"


def test_cli_opportunity_parse_with_title_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _write_llm_config(ws, monkeypatch)

    payload = "<p>Anything — the LLM is the only extractor on this path.</p>"
    llm_response = (
        '{"title": "Auto Title", "role": "Engineer", "company": "Acme", '
        '"required_skills": ["Python"]}'
    )

    with patch.object(
        opportunity_cmd.opp_core, "fetch_url", return_value=payload
    ), patch.object(llm_core, "complete", return_value=llm_response):
        result = runner.invoke(
            app,
            [
                "opportunity",
                "parse",
                "https://example.com/x",
                "--title",
                "My Custom Title",
                "--no-editor",
            ],
        )

    assert result.exit_code == 0, result.output
    target = ws / "opportunities" / "my-custom-title.md"
    assert target.exists()
    front, _ = opp_core.parse_markdown(target.read_text(encoding="utf-8"))
    # User-supplied title wins, role is cleared so it doesn't drift.
    assert front["title"] == "My Custom Title"
    assert front.get("role", "") == ""
    # Other LLM-supplied fields still land.
    assert front["company"] == "Acme"
    assert front["required_skills"] == ["Python"]


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


def test_cli_opportunity_list_accepts_free_form_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Status is free-form; filtering with a value not in the suggested set
    just returns no matches rather than erroring out."""
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["opportunity", "list", "--status", "OA"])
    assert result.exit_code == 0
    assert "no opportunities with status 'oa'" in result.output.lower()


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


def _write_criteria_check_cache(
    workspace: Path,
    slug: str,
    *,
    alignment: int,
    dealbreaker_count: int,
    scored_dimensions: int,
    checked_at: str,
    criteria_hash: str,
) -> None:
    """Stamp a synthetic criteria_check block onto an opportunity's frontmatter."""
    path = workspace / "opportunities" / f"{slug}.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["criteria_check"] = {
        "checked_at": checked_at,
        "alignment": alignment,
        "dealbreaker_count": dealbreaker_count,
        "scored_dimensions": scored_dimensions,
        "criteria_hash": criteria_hash,
    }
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")


def test_cli_opportunity_show_renders_criteria_fit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(ws, {"function": {"want": ["coding"]}})
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])

    current_hash = criteria_core.criteria_hash(criteria_core.load_criteria(ws))
    _write_criteria_check_cache(
        ws,
        "engineer-at-acme",
        alignment=80,
        dealbreaker_count=0,
        scored_dimensions=3,
        checked_at="2026-05-13",
        criteria_hash=current_hash,
    )

    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit: 80%" in result.output
    assert "0 dealbreakers" in result.output
    assert "3 of 5 dimensions scored" in result.output
    assert "2026-05-13" in result.output
    assert "stale" not in result.output.lower()


def test_cli_opportunity_show_flags_stale_criteria_fit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(ws, {"function": {"want": ["coding"]}})
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])

    _write_criteria_check_cache(
        ws,
        "engineer-at-acme",
        alignment=80,
        dealbreaker_count=1,
        scored_dimensions=4,
        checked_at="2026-05-13",
        criteria_hash="stale12345678",  # doesn't match current criteria
    )

    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit:" in result.output
    assert "(stale)" in result.output


def test_cli_opportunity_show_omits_criteria_fit_when_uncached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])

    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit" not in result.output


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


# --- replace_section -------------------------------------------------------


def test_replace_section_swaps_existing_content() -> None:
    body = "## Description\n\ndesc.\n\n## Pros\n\nold pros.\n\n## Notes\n\nnotes.\n"
    out = opp_core.replace_section(body, "## Pros", "new pros.")
    assert "desc." in out
    assert "old pros." not in out
    assert "new pros." in out
    assert "notes." in out


def test_replace_section_appends_when_missing() -> None:
    body = "## Description\n\ndesc.\n"
    out = opp_core.replace_section(body, "## Pros", "fresh pros.")
    assert "desc." in out
    assert out.rstrip().endswith("fresh pros.")
    assert "## Pros" in out


def test_replace_section_handles_section_at_end_of_body() -> None:
    body = "## Description\n\ndesc.\n\n## Pros\n\nold.\n"
    out = opp_core.replace_section(body, "## Pros", "new.")
    assert "old." not in out
    assert "new." in out


def test_replace_section_preserves_sibling_sections_in_order() -> None:
    body = (
        "## Description\n\ndesc.\n\n"
        "## Pros\n\nold pros.\n\n"
        "## Cons\n\nold cons.\n\n"
        "## Notes\n\nnotes.\n"
    )
    out = opp_core.replace_section(body, "## Pros", "new pros.")
    # Order is preserved: description, then pros, then cons, then notes.
    desc_idx = out.index("## Description")
    pros_idx = out.index("## Pros")
    cons_idx = out.index("## Cons")
    notes_idx = out.index("## Notes")
    assert desc_idx < pros_idx < cons_idx < notes_idx
    assert "old cons." in out
    assert "notes." in out


def test_replace_section_is_idempotent() -> None:
    body = "## Pros\n\nfoo.\n\n## Cons\n\nbar.\n"
    once = opp_core.replace_section(body, "## Pros", "result.")
    twice = opp_core.replace_section(once, "## Pros", "result.")
    assert once == twice


# --- save_check_to_opportunity body updates --------------------------------


def _build_check(
    *,
    slug: str,
    title: str = "Engineer at Acme",
    positives: dict[str, list[tuple[str, str]]] | None = None,
    negatives: dict[str, list[tuple[str, str]]] | None = None,
    violations: list[tuple[str, str, str]] | None = None,
) -> criteria_core.CriteriaCheck:
    """Build a CriteriaCheck dataclass for testing body rendering."""
    positives = positives or {}
    negatives = negatives or {}
    violations = violations or []

    dims = []
    for name in criteria_core.DIMENSIONS:
        dim_violations = tuple(
            criteria_core.Violation(dimension=d, phrase=p, context=c)
            for d, p, c in violations
            if d == name
        )
        dims.append(
            criteria_core.DimensionResult(
                name=name,
                status=(
                    criteria_core.STATUS_VIOLATION
                    if dim_violations
                    else criteria_core.STATUS_OK
                ),
                positives=tuple(
                    criteria_core.PhraseMatch(phrase=p, context=c)
                    for p, c in positives.get(name, [])
                ),
                negatives=tuple(
                    criteria_core.PhraseMatch(phrase=p, context=c)
                    for p, c in negatives.get(name, [])
                ),
                violations=dim_violations,
            )
        )
    return criteria_core.CriteriaCheck(
        opportunity_slug=slug,
        opportunity_title=title,
        dimensions=tuple(dims),
    )


def test_save_check_writes_pros_and_cons_into_body(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("backend coding", "Senior Backend Engineer")]},
        negatives={"growth": [("limited mentorship", "small team")]},
        violations=[("location", "fully in-person required", "must be onsite")],
    )

    criteria_core.save_check_to_opportunity(
        ws, check, {"function": {"want": ["coding"]}}, today=date(2026, 5, 13)
    )

    text = (ws / "opportunities" / "engineer-at-acme.md").read_text(encoding="utf-8")
    assert "backend coding" in text
    assert '*"Senior Backend Engineer"*' in text
    assert "limited mentorship" in text
    assert "⚠" in text
    assert "fully in-person required" in text
    assert "dealbreaker triggered" in text
    assert "Auto-generated by `career criteria check` (2026-05-13)" in text


def test_save_check_renders_none_surfaced_when_empty(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(slug="engineer-at-acme")  # no positives, negatives, or violations

    criteria_core.save_check_to_opportunity(
        ws, check, {}, today=date(2026, 5, 13)
    )

    text = (ws / "opportunities" / "engineer-at-acme.md").read_text(encoding="utf-8")
    # Each section gets its own "(none surfaced)" placeholder.
    assert text.count("*(none surfaced)*") == 2


def test_save_check_preserves_notes_section(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    path = opp_core.create_opportunity(ws, title="Engineer at Acme")
    # Stuff some user content into Notes.
    text = path.read_text(encoding="utf-8")
    text = text.replace("## Notes\n", "## Notes\n\nMy own notes that must not be wiped.\n")
    path.write_text(text, encoding="utf-8")

    check = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("backend coding", "")]},
    )
    criteria_core.save_check_to_opportunity(
        ws, check, {}, today=date(2026, 5, 13)
    )

    after = path.read_text(encoding="utf-8")
    assert "My own notes that must not be wiped." in after
    assert "backend coding" in after


def test_save_check_is_idempotent_for_body(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("p1", "context1")]},
    )

    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))
    once = (ws / "opportunities" / "engineer-at-acme.md").read_text(encoding="utf-8")

    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))
    twice = (ws / "opportunities" / "engineer-at-acme.md").read_text(encoding="utf-8")

    assert once == twice


def test_save_check_replaces_prior_body_pros_on_rerun(tmp_path: Path) -> None:
    """An older check's bullets shouldn't survive a new check."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp_core.create_opportunity(ws, title="Engineer at Acme")

    first = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("stale-bullet-text", "")]},
    )
    criteria_core.save_check_to_opportunity(ws, first, {}, today=date(2026, 5, 13))

    second = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("fresh-bullet-text", "")]},
    )
    criteria_core.save_check_to_opportunity(ws, second, {}, today=date(2026, 5, 14))

    text = (ws / "opportunities" / "engineer-at-acme.md").read_text(encoding="utf-8")
    assert "fresh-bullet-text" in text
    assert "stale-bullet-text" not in text
