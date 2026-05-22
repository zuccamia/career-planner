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
from career_planner.core import opportunity as opp_core
from career_planner.core.llm.config import LLMAPIError, LLMConfig
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})

PATCH_COMPLETE_JSON = "career_planner.core.llm.client.complete_json_with_tools"
PATCH_FETCH_URL = "career_planner.commands.opportunity.opp_core.fetch_url"


# --- fixtures & helpers ---


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    return workspace


@pytest.fixture()
def ws_cd(ws: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(ws)
    return ws


def _llm_config() -> LLMConfig:
    return LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def _enable_llm(ws: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")


def _wrap_jsonld(payload: str) -> str:
    return (
        '<html><head><script type="application/ld+json">'
        f"{payload}"
        "</script></head></html>"
    )


def _opp_front(ws: Path, slug: str) -> dict[str, Any]:
    """Read and return an opportunity's frontmatter by slug."""
    text = (ws / "opportunities" / f"{slug}.md").read_text(encoding="utf-8")
    front, _ = opp_core.parse_markdown(text)
    return front


def _opp_text(ws: Path, slug: str) -> str:
    """Read an opportunity file's full text."""
    return (ws / "opportunities" / f"{slug}.md").read_text(encoding="utf-8")


def _mutate_frontmatter(path: Path, **updates: Any) -> None:
    """Merge fields into an existing opportunity's frontmatter."""
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front.update(updates)
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")


# --- Eightfold helpers ---


def _eightfold_payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
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


class _FakeEightfoldResponse:
    def __init__(self, data: dict[str, Any]):
        self._data = data
        self.text = json.dumps(data)

    def raise_for_status(self) -> None: ...

    def json(self) -> dict[str, Any]:
        return self._data


# --- core/opportunity: slugify ---


def test_slugify_strips_punctuation_and_lowercases() -> None:
    assert opp_core.slugify("Staff Engineer at Acme Corp!") == "staff-engineer-at-acme-corp"
    assert opp_core.slugify("  Hello,  World  ") == "hello-world"


def test_slugify_falls_back_when_no_alnum() -> None:
    assert opp_core.slugify("!!!") == "opportunity"
    assert opp_core.slugify("") == "opportunity"


# --- core/opportunity: unique_slug ---


def test_unique_slug_appends_suffix_when_taken(ws: Path) -> None:
    (ws / "opportunities").mkdir(exist_ok=True)
    (ws / "opportunities" / "staff-eng.md").write_text("---\n---\n")
    (ws / "opportunities" / "staff-eng-2.md").write_text("---\n---\n")
    assert opp_core.unique_slug(ws, "staff-eng") == "staff-eng-3"


# --- core/opportunity: create_opportunity ---


def test_create_opportunity_writes_file_with_frontmatter(ws: Path) -> None:
    path = opp_core.create_opportunity(
        ws, title="Staff Engineer at Acme", created=date(2026, 5, 11),
    )
    assert path.exists()
    assert path.parent == ws / "opportunities"
    assert path.stem == "staff-engineer-at-acme"

    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    assert front["title"] == "Staff Engineer at Acme"
    assert front["status"] == "active"
    assert front["created"] == date(2026, 5, 11)
    assert "date_posted" in front
    assert "applied_at" in front
    assert front.get("attachments") == []
    assert "## Description" in body


def test_create_opportunity_dedupes_slug(ws: Path) -> None:
    first = opp_core.create_opportunity(ws, title="Senior Eng at Acme")
    second = opp_core.create_opportunity(ws, title="Senior Eng at Acme")
    assert first.stem == "senior-eng-at-acme"
    assert second.stem == "senior-eng-at-acme-2"


def test_create_opportunity_merges_extra_fields(ws: Path) -> None:
    path = opp_core.create_opportunity(
        ws, title="Engineer",
        url="https://example.com/jobs/1",
        extra={"company": "Globex", "location": "Remote"},
    )
    front, _ = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    assert front["company"] == "Globex"
    assert front["location"] == "Remote"
    assert front["url"] == "https://example.com/jobs/1"


def test_create_opportunity_injects_body_description(ws: Path) -> None:
    path = opp_core.create_opportunity(
        ws, title="Engineer at Acme",
        body_description="Build great things.\n\n- Item one\n- Item two",
    )
    text = path.read_text(encoding="utf-8")
    assert "## Description\n\nBuild great things." in text
    assert "## Pros" in text


# --- core/opportunity: parse_markdown ---


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


# --- core/opportunity: list / find ---


def test_list_opportunities_filters_by_status(ws: Path) -> None:
    a = opp_core.create_opportunity(ws, title="A Job")
    b = opp_core.create_opportunity(ws, title="B Job")
    _mutate_frontmatter(b, status="applied")

    assert {o.slug for o in opp_core.list_opportunities(ws)} == {a.stem, b.stem}
    assert [o.slug for o in opp_core.list_opportunities(ws, status="active")] == [a.stem]
    assert [o.slug for o in opp_core.list_opportunities(ws, status="applied")] == [b.stem]


def test_find_opportunity_prefers_exact_slug(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Senior Engineer")
    opp_core.create_opportunity(ws, title="Senior Engineer at Acme")

    assert [o.slug for o in opp_core.find_opportunity(ws, "senior-engineer")] == ["senior-engineer"]
    assert {o.slug for o in opp_core.find_opportunity(ws, "engineer")} == {
        "senior-engineer", "senior-engineer-at-acme",
    }


def test_find_opportunity_strips_md_suffix(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Lead Eng")
    assert [o.slug for o in opp_core.find_opportunity(ws, "lead-eng.md")] == ["lead-eng"]


# --- core/opportunity: HTML title extraction ---


def test_extract_title_prefers_og_title() -> None:
    html = (
        '<html><head><title>Some Site</title>'
        '<meta property="og:title" content="Senior Engineer — Acme">'
        '</head></html>'
    )
    assert opp_core.extract_title_from_html(html) == "Senior Engineer — Acme"


def test_extract_title_falls_back_to_title_tag() -> None:
    assert opp_core.extract_title_from_html(
        "<html><head><title>  Staff Engineer at Globex  </title></head></html>"
    ) == "Staff Engineer at Globex"


def test_extract_title_decodes_entities() -> None:
    assert opp_core.extract_title_from_html("<title>R&amp;D Lead</title>") == "R&D Lead"


def test_extract_title_returns_empty_when_none_found() -> None:
    assert opp_core.extract_title_from_html("<html><body>No title</body></html>") == ""


# --- core/opportunity: JSON-LD extraction ---


def test_extract_job_posting_from_jsonld_full() -> None:
    payload = """
    {"@context": "https://schema.org", "@type": "JobPosting",
     "title": "Senior Software Engineer",
     "hiringOrganization": {"@type": "Organization", "name": "Microsoft"},
     "jobLocation": {"@type": "Place", "address": {
       "@type": "PostalAddress", "addressLocality": "Redmond",
       "addressRegion": "WA", "addressCountry": {"@type": "Country", "name": "US"}}},
     "datePosted": "2026-05-07T13:32:39Z", "validThrough": "2026-11-03T13:32:39",
     "employmentType": "FULL_TIME",
     "description": "<p>Build great things.</p><ul><li>Ship features</li></ul>"}
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
    assert "work_type" not in result


def test_extract_job_posting_dedupes_country_in_region() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer",
     "jobLocation": {"@type": "Place", "address": {
       "addressLocality": "Redmond", "addressRegion": "WA,US",
       "addressCountry": "US"}}}
    """
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["location"] == "Redmond, WA,US"


def test_extract_job_posting_handles_telecommute() -> None:
    payload = '{"@type": "JobPosting", "title": "Remote Engineer", "jobLocationType": "TELECOMMUTE"}'
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["work_type"] == "remote"


def test_extract_job_posting_handles_type_array() -> None:
    payload = '{"@type": ["JobPosting", "WebPage"], "title": "Data Engineer", "hiringOrganization": "Acme"}'
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["role"] == "Data Engineer"
    assert result["company"] == "Acme"


def test_extract_job_posting_walks_graph() -> None:
    payload = """
    {"@context": "https://schema.org", "@graph": [
      {"@type": "WebPage", "name": "Careers"},
      {"@type": "JobPosting", "title": "ML Researcher",
       "hiringOrganization": {"name": "Globex"}}]}
    """
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["title"] == "ML Researcher at Globex"


def test_extract_job_posting_salary_range() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer",
     "baseSalary": {"@type": "MonetaryAmount", "currency": "USD",
       "value": {"@type": "QuantitativeValue", "minValue": 150000, "maxValue": 200000}}}
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 150000
    assert result["salary_max"] == 200000
    assert result["salary_currency"] == "USD"


def test_extract_job_posting_salary_single_value() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer",
     "baseSalary": {"@type": "MonetaryAmount", "currency": "EUR",
       "value": {"value": 90000}}}
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 90000
    assert result["salary_max"] == 90000
    assert result["salary_currency"] == "EUR"


@pytest.mark.parametrize("field,raw,expected", [
    ("skills", '"Python, AWS; Kubernetes"', ["Python", "AWS", "Kubernetes"]),
    ("skills", '["Python", "AWS", "Kubernetes"]', ["Python", "AWS", "Kubernetes"]),
    ("skills", '[{"@type": "DefinedTerm", "name": "Python"}, {"@type": "DefinedTerm", "name": "AWS"}]',
     ["Python", "AWS"]),
    ("skills", '{"@type": "DefinedTerm", "name": "Python"}', ["Python"]),
    ("skills", '["Python", "python", "AWS", "PYTHON"]', ["Python", "AWS"]),
])
def test_extract_job_posting_skills_formats(field: str, raw: str, expected: list[str]) -> None:
    payload = f'{{"@type": "JobPosting", "title": "Engineer", "{field}": {raw}}}'
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["required_skills"] == expected


def test_extract_job_posting_skills_falls_back_to_skills_required() -> None:
    payload = r'{"@type": "JobPosting", "title": "Engineer", "skillsRequired": "Python\nAWS\nKubernetes"}'
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["required_skills"] == [
        "Python", "AWS", "Kubernetes",
    ]


def test_extract_job_posting_skills_absent_when_no_field() -> None:
    assert "required_skills" not in opp_core.extract_job_posting(
        _wrap_jsonld('{"@type": "JobPosting", "title": "Engineer"}')
    )


def test_extract_job_posting_ignores_malformed_jsonld() -> None:
    html_doc = (
        '<html><head>'
        '<script type="application/ld+json">{ not valid json }</script>'
        '<meta property="og:title" content="Fallback Title">'
        '</head></html>'
    )
    assert opp_core.extract_job_posting(html_doc)["title"] == "Fallback Title"


def test_extract_job_posting_skips_non_job_jsonld() -> None:
    html_doc = (
        _wrap_jsonld('{"@type": "Organization", "name": "Acme"}')
        + '<meta property="og:title" content="Some Role at Acme">'
    )
    assert opp_core.extract_job_posting(html_doc)["title"] == "Some Role at Acme"


def test_extract_job_posting_infers_salary_from_description() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer",
     "description": "<p>USD $150,000 - $200,000 per year plus benefits.</p>"}
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 150000
    assert result["salary_max"] == 200000
    assert result["salary_currency"] == "USD"


def test_extract_job_posting_does_not_override_structured_salary() -> None:
    payload = """
    {"@type": "JobPosting", "title": "Engineer",
     "baseSalary": {"@type": "MonetaryAmount", "currency": "USD",
       "value": {"minValue": 120000, "maxValue": 140000}},
     "description": "<p>The role pays $150,000 - $200,000.</p>"}
    """
    result = opp_core.extract_job_posting(_wrap_jsonld(payload))
    assert result["salary_min"] == 120000
    assert result["salary_max"] == 140000


def test_extract_job_posting_infers_work_type_from_description() -> None:
    payload = '{"@type": "JobPosting", "title": "Engineer", "description": "<p>This role is fully remote.</p>"}'
    assert opp_core.extract_job_posting(_wrap_jsonld(payload))["work_type"] == "remote"


def test_extract_job_posting_og_fallback() -> None:
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


def test_html_to_text_strips_script_and_style_content() -> None:
    html_doc = (
        "<div>Hello"
        "<script>var secret = {pay: 1234};</script>"
        "<style>body { color: red; }</style>"
        " world</div>"
    )
    assert opp_core._html_to_text(html_doc) == "Hello world"


# --- Eightfold ATS ---


@pytest.mark.parametrize("url,expected", [
    ("https://apply.careers.microsoft.com/careers?pid=1970393556752618&hl=en", "1970393556752618"),
    ("https://apply.careers.microsoft.com/careers/job/1970393556752618", "1970393556752618"),
    ("https://acme-corp.eightfold.ai/careers?pid=42", "42"),
    ("https://jobs.example.com/listing?pid=42", ""),
    ("https://apply.careers.microsoft.com/careers?query=engineer", ""),
])
def test_eightfold_pid_detects_supported_url_shapes(url: str, expected: str) -> None:
    assert opp_core._eightfold_pid(url) == expected


def test_company_from_eightfold_host() -> None:
    f = opp_core._company_from_eightfold_host
    assert f("https://apply.careers.microsoft.com/careers?pid=1") == "Microsoft"
    assert f("https://apply.careers.bristol-myers-squibb.com/careers?pid=1") == "Bristol Myers Squibb"
    assert f("https://acme-corp.eightfold.ai/careers?pid=1") == "Acme Corp"
    assert f("https://example.com/careers") == ""


def test_fetch_url_uses_eightfold_api_when_pid_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _eightfold_payload()
    captured: dict[str, str] = {}

    def fake_get(url: str, **kwargs: Any) -> _FakeEightfoldResponse:
        captured["url"] = url
        return _FakeEightfoldResponse(payload)

    import httpx
    monkeypatch.setattr(httpx, "get", fake_get)

    url = (
        "https://apply.careers.microsoft.com/careers?domain=microsoft.com"
        "&pid=1970393556752618&hl=en"
    )
    synth = opp_core.fetch_url(url)
    assert captured["url"] == "https://apply.careers.microsoft.com/api/apply/v2/jobs/1970393556752618"

    fields = opp_core.extract_job_posting(synth)
    assert fields["role"] == "Teams Copilot Software Engineer"
    assert fields["company"] == "Microsoft"
    assert "Redmond" in fields["location"]
    assert fields["date_posted"] == "2026-02-06"
    assert fields["salary_min"] == 100600
    assert fields["salary_max"] == 199000
    assert fields["salary_currency"] == "USD"
    assert "Build the next generation of Teams" in fields["description"]

    body_text = opp_core._html_to_text(synth)
    for expected in (
        "Role: Teams Copilot Software Engineer",
        "Company: Microsoft",
        "Location: United States, Washington, Redmond",
        "Date posted: 2026-02-06",
        "Salary: USD 100,600 - 199,000",
    ):
        assert expected in body_text


def test_fetch_url_eightfold_maps_remote_flexibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _eightfold_payload(location_flexibility="remoteGlobal")

    import httpx
    monkeypatch.setattr(httpx, "get", lambda url, **kw: _FakeEightfoldResponse(payload))

    synth = opp_core.fetch_url("https://apply.careers.microsoft.com/careers?pid=42")
    assert opp_core.extract_job_posting(synth)["work_type"] == "remote"


def test_fetch_url_falls_back_to_html_when_eightfold_api_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class _Failing:
        text = ""
        def raise_for_status(self) -> None:
            import httpx
            raise httpx.HTTPStatusError("boom", request=None, response=None)  # type: ignore[arg-type]
        def json(self) -> dict:
            return {}

    class _Html:
        text = "<html><head><title>Backup</title></head></html>"
        def raise_for_status(self) -> None: ...

    def fake_get(url: str, **kwargs: Any) -> Any:
        calls.append(url)
        return _Failing() if "/api/apply/" in url else _Html()

    import httpx
    monkeypatch.setattr(httpx, "get", fake_get)

    body = opp_core.fetch_url("https://apply.careers.microsoft.com/careers?pid=42")
    assert "Backup" in body
    assert any("/api/apply/" in u for u in calls)
    assert any("/api/apply/" not in u for u in calls)


# --- core/opportunity: llm_extract_posting ---


def test_llm_extract_posting_returns_full_frontmatter_shape() -> None:
    captured: dict = {}
    resp = {
        "title": "Senior Engineer at Acme", "role": "Senior Engineer",
        "company": "Acme", "location": "NYC", "work_type": "hybrid",
        "date_posted": "2026-05-01", "deadline": "2026-09-30",
        "salary_min": 150000, "salary_max": 200000, "salary_currency": "USD",
        "required_skills": ["Python", "AWS"],
        "description": "Build the platform.",
    }

    def fake(config, *, system, user, **kwargs):
        captured["user"] = user
        return resp

    with patch(PATCH_COMPLETE_JSON, side_effect=fake):
        out = opp_core.llm_extract_posting("<p>Acme is hiring.</p>", _llm_config())

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
        "required_skills": ["aws", "python"],
        "description": "Build the platform.",
    }
    for key in ("title", "role", "company", "location", "work_type",
                "salary_min", "salary_currency", "required_skills", "description"):
        assert key in captured["user"]


def test_llm_extract_posting_drops_nulls_and_invalid_values() -> None:
    resp = {
        "title": "Engineer at Acme", "role": "Engineer", "company": "Acme",
        "location": None, "work_type": "flexible", "date_posted": None,
        "deadline": "someday", "salary_min": None, "salary_max": None,
        "salary_currency": "dollars", "required_skills": [],
        "description": None,
    }
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        out = opp_core.llm_extract_posting("<p>...</p>", _llm_config())

    assert out["title"] == "Engineer at Acme"
    for key in ("location", "work_type", "date_posted", "deadline",
                "salary_currency", "salary_min", "salary_max",
                "required_skills", "description"):
        assert key not in out


def test_llm_extract_posting_dedupes_skills_case_insensitive() -> None:
    resp = {
        "title": "Engineer at Acme", "role": "Engineer", "company": "Acme",
        "required_skills": ["Python", "python", "AWS", "aws", "Go"],
    }
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        out = opp_core.llm_extract_posting("<p>...</p>", _llm_config())
    assert out["required_skills"] == ["aws", "go", "python"]


def test_llm_extract_posting_coerces_float_salary_to_int() -> None:
    resp = {
        "title": "Engineer at Acme", "role": "Engineer", "company": "Acme",
        "salary_min": 100000.0, "salary_max": 150000.5, "salary_currency": "USD",
    }
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        out = opp_core.llm_extract_posting("<p>...</p>", _llm_config())
    assert out["salary_min"] == 100_000
    assert "salary_max" not in out


def test_llm_extract_posting_raises_on_malformed_json() -> None:
    with patch(PATCH_COMPLETE_JSON, side_effect=LLMAPIError("invalid JSON")):
        with pytest.raises(LLMAPIError):
            opp_core.llm_extract_posting("<p>...</p>", _llm_config())


def test_llm_extract_posting_truncates_long_pages() -> None:
    captured: dict = {}

    def fake(config, *, system, user, **kwargs):
        captured["user"] = user
        return {"title": "X", "role": "Y", "company": "Z"}

    long_body = "<p>" + ("lorem ipsum " * 10_000) + "</p>"
    with patch(PATCH_COMPLETE_JSON, side_effect=fake):
        opp_core.llm_extract_posting(long_body, _llm_config(), max_chars=5_000)
    assert len(captured["user"]) < 5_000 + 3_000  # max_chars + prompt overhead


# --- core/opportunity: body-text salary inference ---


@pytest.mark.parametrize("text,expected", [
    ("Salary: $150K-$200K + equity",
     {"salary_min": 150_000, "salary_max": 200_000, "salary_currency": "USD"}),
    ("Base salary $150,000-$200,000 per year",
     {"salary_min": 150_000, "salary_max": 200_000, "salary_currency": "USD"}),
    ("Range: $150-200K", {"salary_min": 150_000, "salary_max": 200_000}),
    ("$150K to $200K", {"salary_min": 150_000, "salary_max": 200_000}),
    ("$150K\u2013$200K", {"salary_min": 150_000, "salary_max": 200_000}),
    ("150,000-200,000 USD",
     {"salary_min": 150_000, "salary_max": 200_000, "salary_currency": "USD"}),
    ("\u20ac80K-\u20ac100K base",
     {"salary_min": 80_000, "salary_max": 100_000, "salary_currency": "EUR"}),
    ("70-90K GBP per annum",
     {"salary_min": 70_000, "salary_max": 90_000, "salary_currency": "GBP"}),
])
def test_extract_salary_from_text(text: str, expected: dict) -> None:
    result = opp_core.extract_salary_from_text(text)
    for k, v in expected.items():
        assert result[k] == v


@pytest.mark.parametrize("text", [
    "No salary disclosed.", "", "Team of 5-10 engineers.",
])
def test_extract_salary_from_text_returns_empty(text: str) -> None:
    assert opp_core.extract_salary_from_text(text) == {}


def test_extract_salary_from_text_first_match_wins() -> None:
    out = opp_core.extract_salary_from_text("Base $150K-$200K; previously 100-120K USD.")
    assert out["salary_min"] == 150_000
    assert out["salary_max"] == 200_000


# --- core/opportunity: body-text work_type inference ---


@pytest.mark.parametrize("text,expected", [
    ("This is a fully remote role.", "remote"),
    ("100% remote position", "remote"),
    ("Remote-first team", "remote"),
    ("remote only role", "remote"),
    ("You can work from anywhere.", "remote"),
    ("5 days a week in office", "in-person"),
    ("fully in-person team", "in-person"),
    ("Hybrid schedule", "hybrid"),
    ("3 days per week in office", "hybrid"),
])
def test_extract_work_type_from_text(text: str, expected: str) -> None:
    assert opp_core.extract_work_type_from_text(text) == expected


def test_extract_work_type_strong_signal_beats_soft() -> None:
    assert opp_core.extract_work_type_from_text(
        "This is a fully remote role; some teams are hybrid."
    ) == "remote"


@pytest.mark.parametrize("text", ["Remote-friendly culture.", ""])
def test_extract_work_type_returns_empty_when_ambiguous(text: str) -> None:
    assert opp_core.extract_work_type_from_text(text) == ""


# --- core/opportunity: replace_section ---


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


# --- core/criteria: save_check_to_opportunity ---


def _build_check(
    *,
    slug: str,
    title: str = "Engineer at Acme",
    positives: dict[str, list[tuple[str, str]]] | None = None,
    negatives: dict[str, list[tuple[str, str]]] | None = None,
    violations: list[tuple[str, str, str]] | None = None,
) -> criteria_core.CriteriaCheck:
    positives = positives or {}
    negatives = negatives or {}
    violations = violations or []

    dims = []
    for name in criteria_core.DIMENSIONS:
        dim_violations = tuple(
            criteria_core.Violation(dimension=d, phrase=p, context=c)
            for d, p, c in violations if d == name
        )
        dims.append(criteria_core.DimensionResult(
            name=name,
            status=(criteria_core.STATUS_VIOLATION if dim_violations else criteria_core.STATUS_OK),
            positives=tuple(
                criteria_core.PhraseMatch(phrase=p, context=c)
                for p, c in positives.get(name, [])
            ),
            negatives=tuple(
                criteria_core.PhraseMatch(phrase=p, context=c)
                for p, c in negatives.get(name, [])
            ),
            violations=dim_violations,
        ))
    return criteria_core.CriteriaCheck(
        opportunity_slug=slug, opportunity_title=title, dimensions=tuple(dims),
    )


def test_save_check_writes_pros_and_cons_into_body(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(
        slug="engineer-at-acme",
        positives={"function": [("backend coding", "Senior Backend Engineer")]},
        negatives={"growth": [("limited mentorship", "small team")]},
        violations=[("location", "fully in-person required", "must be onsite")],
    )
    criteria_core.save_check_to_opportunity(
        ws, check, {"function": {"want": ["coding"]}}, today=date(2026, 5, 13),
    )

    text = _opp_text(ws, "engineer-at-acme")
    for expected in ("backend coding", '*"Senior Backend Engineer"*',
                     "limited mentorship", "\u26a0", "fully in-person required",
                     "dealbreaker triggered",
                     "Auto-generated by `career criteria check` (2026-05-13)"):
        assert expected in text


def test_save_check_renders_none_surfaced_when_empty(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(slug="engineer-at-acme")
    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))
    assert _opp_text(ws, "engineer-at-acme").count("*(none surfaced)*") == 2


def test_save_check_preserves_notes_section(ws: Path) -> None:
    path = opp_core.create_opportunity(ws, title="Engineer at Acme")
    text = path.read_text(encoding="utf-8")
    path.write_text(
        text.replace("## Notes\n", "## Notes\n\nMy own notes that must not be wiped.\n"),
        encoding="utf-8",
    )

    check = _build_check(slug="engineer-at-acme", positives={"function": [("backend coding", "")]})
    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))

    after = path.read_text(encoding="utf-8")
    assert "My own notes that must not be wiped." in after
    assert "backend coding" in after


def test_save_check_is_idempotent_for_body(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Engineer at Acme")
    check = _build_check(slug="engineer-at-acme", positives={"function": [("p1", "context1")]})

    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))
    once = _opp_text(ws, "engineer-at-acme")
    criteria_core.save_check_to_opportunity(ws, check, {}, today=date(2026, 5, 13))
    twice = _opp_text(ws, "engineer-at-acme")
    assert once == twice


def test_save_check_replaces_prior_body_pros_on_rerun(ws: Path) -> None:
    opp_core.create_opportunity(ws, title="Engineer at Acme")

    first = _build_check(slug="engineer-at-acme", positives={"function": [("stale-bullet-text", "")]})
    criteria_core.save_check_to_opportunity(ws, first, {}, today=date(2026, 5, 13))

    second = _build_check(slug="engineer-at-acme", positives={"function": [("fresh-bullet-text", "")]})
    criteria_core.save_check_to_opportunity(ws, second, {}, today=date(2026, 5, 14))

    text = _opp_text(ws, "engineer-at-acme")
    assert "fresh-bullet-text" in text
    assert "stale-bullet-text" not in text


# --- CLI: career opportunity add ---


def test_cli_opportunity_add_creates_file(ws_cd: Path) -> None:
    result = runner.invoke(app, ["opportunity", "add", "Staff Engineer at Acme Corp", "--no-editor"])
    assert result.exit_code == 0, result.output

    front, body = opp_core.parse_markdown(_opp_text(ws_cd, "staff-engineer-at-acme-corp"))
    assert front["title"] == "Staff Engineer at Acme Corp"
    assert front["status"] == "active"
    assert "## Description" in body
    assert "staff-engineer-at-acme-corp" in result.output


def test_cli_opportunity_add_opens_editor_by_default(ws_cd: Path) -> None:
    captured: list[Path] = []

    def fake_open(file_path: Path, editor: str) -> int:
        captured.append(file_path)
        return 0

    with patch.object(common_cmd, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(app, ["opportunity", "add", "A Role"])
    assert result.exit_code == 0, result.output
    assert captured == [ws_cd / "opportunities" / "a-role.md"]


def test_cli_opportunity_add_handles_missing_editor(ws_cd: Path) -> None:
    with patch.object(common_cmd, "open_in_editor", side_effect=FileNotFoundError("missing")):
        result = runner.invoke(app, ["opportunity", "add", "A Role"])
    assert result.exit_code == 0
    assert "editor not found" in result.output.lower()


def test_cli_opportunity_add_requires_title_or_url(ws_cd: Path) -> None:
    result = runner.invoke(app, ["opportunity", "add", "--no-editor"])
    assert result.exit_code == 1
    assert "title" in result.output.lower() or "url" in result.output.lower()


def test_cli_opportunity_add_with_url_uses_extracted_title(ws_cd: Path) -> None:
    html_body = (
        '<html><head>'
        '<meta property="og:title" content="Senior Engineer at Globex">'
        "<title>Globex Careers</title></head></html>"
    )
    with patch(PATCH_FETCH_URL, return_value=html_body):
        result = runner.invoke(
            app, ["opportunity", "add", "--url", "https://example.com/jobs/1", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    front = _opp_front(ws_cd, "senior-engineer-at-globex")
    assert front["title"] == "Senior Engineer at Globex"
    assert front["url"] == "https://example.com/jobs/1"


def test_cli_opportunity_add_with_url_falls_back_on_fetch_failure(ws_cd: Path) -> None:
    with patch(PATCH_FETCH_URL, side_effect=RuntimeError("connection refused")):
        result = runner.invoke(
            app, ["opportunity", "add", "--url", "https://example.com/jobs/2", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    assert "could not fetch" in result.output.lower()
    assert len(list((ws_cd / "opportunities").glob("*.md"))) == 1


def test_cli_opportunity_add_with_url_and_explicit_title(ws_cd: Path) -> None:
    with patch(PATCH_FETCH_URL, return_value="<title>Auto Title</title>"):
        result = runner.invoke(
            app, ["opportunity", "add", "My Custom Title", "--url", "https://example.com/x", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    front = _opp_front(ws_cd, "my-custom-title")
    assert front["title"] == "My Custom Title"
    assert front["url"] == "https://example.com/x"


def test_cli_opportunity_add_with_jsonld_url_populates_fields(ws_cd: Path) -> None:
    payload = """
    <html><head><script type="application/ld+json">
    {"@type": "JobPosting", "title": "Senior Software Engineer",
     "hiringOrganization": {"name": "Microsoft"},
     "jobLocation": {"@type": "Place",
       "address": {"addressLocality": "Redmond", "addressRegion": "WA",
                   "addressCountry": "US"}},
     "datePosted": "2026-05-07", "validThrough": "2026-11-03",
     "description": "<p>Build intelligent infrastructure.</p>"}
    </script></head></html>
    """
    with patch(PATCH_FETCH_URL, return_value=payload):
        result = runner.invoke(
            app, ["opportunity", "add", "--url", "https://example.com/jobs/1", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    front, body = opp_core.parse_markdown(
        _opp_text(ws_cd, "senior-software-engineer-at-microsoft"),
    )
    assert front["title"] == "Senior Software Engineer at Microsoft"
    assert front["company"] == "Microsoft"
    assert front["location"] == "Redmond, WA, US"
    assert str(front["date_posted"]) == "2026-05-07"
    assert str(front["deadline"]) == "2026-11-03"
    assert "Build intelligent infrastructure" in body


def test_cli_opportunity_add_with_jsonld_skills(ws_cd: Path) -> None:
    payload = """
    <script type="application/ld+json">
    {"@type": "JobPosting", "title": "Senior Engineer",
     "hiringOrganization": {"name": "Acme"},
     "skills": ["Python", "AWS", "Kubernetes"]}
    </script>
    """
    with patch(PATCH_FETCH_URL, return_value=payload):
        result = runner.invoke(
            app, ["opportunity", "add", "--url", "https://example.com/jobs/1", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    assert _opp_front(ws_cd, "senior-engineer-at-acme")["required_skills"] == [
        "Python", "AWS", "Kubernetes",
    ]


def test_cli_opportunity_add_with_explicit_title_keeps_extracted_fields(ws_cd: Path) -> None:
    payload = """
    <script type="application/ld+json">
    {"@type": "JobPosting", "title": "Generic Title",
     "hiringOrganization": {"name": "Acme"},
     "jobLocation": {"address": {"addressLocality": "Remote"}}}
    </script>
    """
    with patch(PATCH_FETCH_URL, return_value=payload):
        result = runner.invoke(
            app, ["opportunity", "add", "My Override", "--url", "https://example.com/x", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    front = _opp_front(ws_cd, "my-override")
    assert front["title"] == "My Override"
    assert front.get("role", "") == ""
    assert front["company"] == "Acme"
    assert front["location"] == "Remote"


# --- CLI: career opportunity parse ---


def test_cli_opportunity_parse_writes_llm_fields_to_frontmatter(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_llm(ws_cd, monkeypatch)
    payload = """
    <html><body>
    <script type="application/ld+json">
    {"@type": "JobPosting", "title": "Stale JSON-LD Title",
     "hiringOrganization": {"name": "Stale Inc"}}
    </script>
    <p>Real posting text the LLM would actually read.</p>
    </body></html>
    """
    llm_resp = {
        "title": "Senior Engineer at Globex",
        "role": "Senior Engineer", "company": "Globex",
        "location": "NYC", "work_type": "hybrid",
        "date_posted": "2026-05-01", "deadline": None,
        "salary_min": 180000, "salary_max": 220000, "salary_currency": "USD",
        "required_skills": ["Python", "Go"],
        "description": "Build the platform team.",
    }
    with patch(PATCH_FETCH_URL, return_value=payload), \
         patch(PATCH_COMPLETE_JSON, return_value=llm_resp):
        result = runner.invoke(
            app, ["opportunity", "parse", "https://example.com/jobs/x", "--no-editor"],
        )
    assert result.exit_code == 0, result.output

    text = _opp_text(ws_cd, "senior-engineer-at-globex")
    front, body = opp_core.parse_markdown(text)
    assert front["company"] == "Globex"
    assert front["role"] == "Senior Engineer"
    assert front["location"] == "NYC"
    assert front["work_type"] == "hybrid"
    assert front["required_skills"] == ["go", "python"]
    assert front["salary_min"] == 180_000
    assert front["salary_max"] == 220_000
    assert front["salary_currency"] == "USD"
    assert "Build the platform team." in body
    assert "Stale" not in text


def test_cli_opportunity_parse_missing_llm_config_exits_3(ws_cd: Path) -> None:
    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Role",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )
    with patch(PATCH_FETCH_URL, return_value=payload):
        result = runner.invoke(
            app, ["opportunity", "parse", "https://example.com/x", "--no-editor"],
        )
    assert result.exit_code == 3, result.output
    assert "config.yml" in result.output
    assert not list((ws_cd / "opportunities").glob("*.md"))


def test_cli_opportunity_parse_llm_failure_falls_back_to_structured(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_llm(ws_cd, monkeypatch)
    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Senior Engineer",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )
    with patch(PATCH_FETCH_URL, return_value=payload), \
         patch(PATCH_COMPLETE_JSON, side_effect=LLMAPIError("HTTP 500")):
        result = runner.invoke(
            app, ["opportunity", "parse", "https://example.com/x", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    assert "extraction failed" in result.output.lower()
    front = _opp_front(ws_cd, "senior-engineer-at-acme")
    assert front["company"] == "Acme"
    assert front["role"] == "Senior Engineer"


def test_cli_opportunity_parse_malformed_json_falls_back_to_structured(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_llm(ws_cd, monkeypatch)
    payload = (
        '<script type="application/ld+json">'
        '{"@type": "JobPosting", "title": "Engineer",'
        ' "hiringOrganization": {"name": "Acme"}}'
        "</script>"
    )
    with patch(PATCH_FETCH_URL, return_value=payload), \
         patch(PATCH_COMPLETE_JSON, side_effect=LLMAPIError("invalid JSON")):
        result = runner.invoke(
            app, ["opportunity", "parse", "https://example.com/x", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    assert "extraction failed" in result.output.lower()
    assert _opp_front(ws_cd, "engineer-at-acme")["company"] == "Acme"


def test_cli_opportunity_parse_with_title_override(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_llm(ws_cd, monkeypatch)
    llm_resp = {
        "title": "Auto Title", "role": "Engineer", "company": "Acme",
        "required_skills": ["Python"],
    }
    with patch(PATCH_FETCH_URL, return_value="<p>Anything.</p>"), \
         patch(PATCH_COMPLETE_JSON, return_value=llm_resp):
        result = runner.invoke(
            app, ["opportunity", "parse", "https://example.com/x",
                  "--title", "My Custom Title", "--no-editor"],
        )
    assert result.exit_code == 0, result.output
    front = _opp_front(ws_cd, "my-custom-title")
    assert front["title"] == "My Custom Title"
    assert front.get("role", "") == ""
    assert front["company"] == "Acme"
    assert front["required_skills"] == ["python"]


# --- CLI: career opportunity list ---


def test_cli_opportunity_list_empty(ws_cd: Path) -> None:
    result = runner.invoke(app, ["opportunity", "list"])
    assert result.exit_code == 0, result.output
    assert "no opportunities" in result.output.lower()


def test_cli_opportunity_list_renders_table(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    runner.invoke(app, ["opportunity", "add", "Staff Engineer at Globex", "--no-editor"])
    result = runner.invoke(app, ["opportunity", "list"])
    assert result.exit_code == 0, result.output
    assert "senior-engineer-at-acme" in result.output
    assert "staff-engineer-at-globex" in result.output


def test_cli_opportunity_list_filters_by_status(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "A Job", "--no-editor"])
    runner.invoke(app, ["opportunity", "add", "B Job", "--no-editor"])
    _mutate_frontmatter(ws_cd / "opportunities" / "b-job.md", status="applied")

    active = runner.invoke(app, ["opportunity", "list", "--status", "active"])
    assert "a-job" in active.output
    assert "b-job" not in active.output

    applied = runner.invoke(app, ["opportunity", "list", "--status", "applied"])
    assert "b-job" in applied.output
    assert "a-job" not in applied.output


def test_cli_opportunity_list_accepts_free_form_status(ws_cd: Path) -> None:
    result = runner.invoke(app, ["opportunity", "list", "--status", "OA"])
    assert result.exit_code == 0
    assert "no opportunities with status 'oa'" in result.output.lower()


# --- CLI: career opportunity show ---


def test_cli_opportunity_show_prints_details(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    path = ws_cd / "opportunities" / "senior-engineer-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front.update(company="Acme Corp", role="Senior Engineer",
                 location="Remote", salary_min=150000, salary_max=180000)
    body += "\n## Description\n\nExciting role.\n"
    path.write_text(opp_core.serialize_markdown(front, body), encoding="utf-8")

    result = runner.invoke(app, ["opportunity", "show", "senior-engineer-at-acme"])
    assert result.exit_code == 0, result.output
    for expected in ("Senior Engineer at Acme", "Acme Corp", "Remote", "150000", "Exciting role"):
        assert expected in result.output


def test_cli_opportunity_show_renders_notion_export_fields(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    _mutate_frontmatter(
        ws_cd / "opportunities" / "senior-engineer-at-acme.md",
        date_posted="2026-05-01",
        applied_at="2026-05-08",
        attachments=["resume-acme-v1.pdf", "cover-letter-acme.pdf"],
    )
    result = runner.invoke(app, ["opportunity", "show", "senior-engineer-at-acme"])
    assert result.exit_code == 0, result.output
    for expected in ("2026-05-01", "2026-05-08", "resume-acme-v1.pdf", "cover-letter-acme.pdf"):
        assert expected in result.output


def test_cli_opportunity_show_substring_match(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    result = runner.invoke(app, ["opportunity", "show", "acme"])
    assert result.exit_code == 0, result.output
    assert "Senior Engineer at Acme" in result.output


def test_cli_opportunity_show_missing_exits_1(ws_cd: Path) -> None:
    result = runner.invoke(app, ["opportunity", "show", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_opportunity_show_disambiguates_multiple_matches(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Globex", "--no-editor"])
    result = runner.invoke(app, ["opportunity", "show", "engineer"], input="1\n")
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


# --- CLI: career opportunity show — criteria fit ---


def _write_criteria_check_cache(
    ws: Path, slug: str, *,
    alignment: int, dealbreaker_count: int, scored_dimensions: int,
    checked_at: str, criteria_hash: str,
) -> None:
    _mutate_frontmatter(
        ws / "opportunities" / f"{slug}.md",
        criteria_check={
            "checked_at": checked_at,
            "alignment": alignment,
            "dealbreaker_count": dealbreaker_count,
            "scored_dimensions": scored_dimensions,
            "criteria_hash": criteria_hash,
        },
    )


def test_cli_opportunity_show_renders_criteria_fit(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, {"function": {"want": ["coding"]}})
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])

    current_hash = criteria_core.criteria_hash(criteria_core.load_criteria(ws_cd))
    _write_criteria_check_cache(
        ws_cd, "engineer-at-acme",
        alignment=80, dealbreaker_count=0, scored_dimensions=3,
        checked_at="2026-05-13", criteria_hash=current_hash,
    )

    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit: 80%" in result.output
    assert "0 dealbreakers" in result.output
    assert "3 of 5 dimensions scored" in result.output
    assert "2026-05-13" in result.output
    assert "stale" not in result.output.lower()


def test_cli_opportunity_show_flags_stale_criteria_fit(ws_cd: Path) -> None:
    criteria_core.save_criteria(ws_cd, {"function": {"want": ["coding"]}})
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])
    _write_criteria_check_cache(
        ws_cd, "engineer-at-acme",
        alignment=80, dealbreaker_count=1, scored_dimensions=4,
        checked_at="2026-05-13", criteria_hash="stale12345678",
    )

    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit:" in result.output
    assert "(stale)" in result.output


def test_cli_opportunity_show_omits_criteria_fit_when_uncached(ws_cd: Path) -> None:
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])
    result = runner.invoke(app, ["opportunity", "show", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Criteria fit" not in result.output


def test_cli_opportunity_commands_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    for args in (
        ["opportunity", "add", "X", "--no-editor"],
        ["opportunity", "list"],
        ["opportunity", "show", "x"],
    ):
        assert runner.invoke(app, args).exit_code == 2