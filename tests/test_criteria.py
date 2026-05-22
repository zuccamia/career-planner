"""Tests for the criteria module and the `career criteria` CLI."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import _common as common_cmd
from career_planner.core import criteria as criteria_core
from career_planner.core import opportunity as opp_core
from career_planner.core.llm.config import LLMAPIError, LLMConfig
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})

PATCH_COMPLETE_JSON = "career_planner.core.criteria.complete_json"


# --- fixtures ---


@pytest.fixture()
def ws(tmp_path: Path) -> Path:
    workspace = tmp_path / "ws"
    create_workspace(workspace)
    return workspace


@pytest.fixture()
def ws_cd(ws: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(ws)
    return ws


def _enable_llm(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (workspace / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")


def _llm_config() -> LLMConfig:
    return LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def _make_opportunity(
    workspace: Path,
    *,
    title: str = "Senior Engineer at Acme",
    body: str = "",
) -> opp_core.Opportunity:
    path = opp_core.create_opportunity(workspace, title=title)
    if body:
        text = path.read_text(encoding="utf-8")
        front, current_body = opp_core.parse_markdown(text)
        new_body = current_body + "\n## Description\n\n" + body + "\n"
        path.write_text(
            opp_core.serialize_markdown(front, new_body), encoding="utf-8"
        )
    return opp_core.load_opportunity(workspace, path.stem)


def _check_response(
    dimensions: list[dict] | None = None,
    summary: str = "",
) -> dict:
    return {"dimensions": dimensions or [], "summary": summary}


def _dim(
    name: str = "function",
    status: str = "strong",
    summary: str = "",
    positives: list[dict] | None = None,
    negatives: list[dict] | None = None,
    violations: list[dict] | None = None,
) -> dict:
    return {
        "name": name,
        "status": status,
        "summary": summary,
        "positives": positives or [],
        "negatives": negatives or [],
        "violations": violations or [],
    }


BASIC_CRITERIA = {
    "function": {"want": ["coding"], "dread": [], "dealbreakers": ["no coding at all"]},
}


def _setup_criteria_and_opp(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> Path:
    monkeypatch.chdir(ws)
    criteria_core.save_criteria(ws, BASIC_CRITERIA)
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])
    return ws


# --- core/criteria.py: file I/O ---


def test_criteria_path_points_at_workspace_root(ws: Path) -> None:
    assert criteria_core.criteria_path(ws) == ws / "criteria.yml"


def test_load_criteria_returns_empty_dict_when_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    assert criteria_core.load_criteria(ws) == {}


def test_load_criteria_reads_template_after_init(ws: Path) -> None:
    data = criteria_core.load_criteria(ws)
    for dim in criteria_core.DIMENSIONS:
        assert dim in data


def test_save_and_load_round_trip(ws: Path) -> None:
    payload = {
        "function": {"want": ["coding"], "dread": [], "dealbreakers": []},
        "compensation": {"base_minimum": 150000, "base_target": 180000},
    }
    criteria_core.save_criteria(ws, payload)
    assert criteria_core.load_criteria(ws) == payload


# --- dimension introspection ---


def test_is_dimension_empty_true_for_fresh_template(ws: Path) -> None:
    data = criteria_core.load_criteria(ws)
    for dim in criteria_core.DIMENSIONS:
        dim_data = criteria_core.dimension_data(data, dim)
        assert criteria_core.is_dimension_empty(dim, dim_data) is True


def test_is_dimension_empty_false_when_list_has_content() -> None:
    dim_data = {"want": ["coding"], "dread": [], "dealbreakers": []}
    assert criteria_core.is_dimension_empty("function", dim_data) is False


def test_is_dimension_empty_false_when_number_set() -> None:
    dim_data = {"base_minimum": 150000, "base_target": 0}
    assert criteria_core.is_dimension_empty("compensation", dim_data) is False


def test_is_dimension_empty_ignores_empty_strings() -> None:
    dim_data = {"work_type": "  ", "willing_to_relocate": False, "preferred": []}
    assert criteria_core.is_dimension_empty("location", dim_data) is True


def test_missing_fields_lists_empty_fields() -> None:
    dim_data = {"want": ["coding"], "dread": [], "dealbreakers": ["no coding"]}
    missing = criteria_core.missing_fields("function", dim_data)
    assert "dread" in missing
    assert "want" not in missing
    assert "dealbreakers" not in missing


# --- CriteriaCheck.alignment property ---


def test_alignment_excludes_unknown_dimensions() -> None:
    check = criteria_core.CriteriaCheck(
        opportunity_slug="x",
        opportunity_title="X",
        dimensions=(
            criteria_core.DimensionResult(
                name="function",
                status=criteria_core.STATUS_STRONG,
                positives=(), negatives=(), violations=(),
            ),
            criteria_core.DimensionResult(
                name="culture",
                status=criteria_core.STATUS_UNKNOWN,
                positives=(), negatives=(), violations=(),
            ),
        ),
    )
    assert check.alignment == 1.0


# --- check_against_opportunity: response parsing ---


def test_check_parses_full_response(ws: Path) -> None:
    opp = _make_opportunity(ws, body="Backend role.")
    resp = _check_response(
        dimensions=[
            _dim("function", "strong", "Coding-heavy role.",
                 positives=[{"phrase": "backend coding", "context": "Backend role."}]),
            _dim("compensation", "violation", "Below floor.",
                 violations=[{"phrase": "salary below floor", "context": "90k"}]),
        ],
        summary="Mixed verdict overall.",
    )
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())

    by_name = {d.name: d for d in check.dimensions}
    assert by_name["function"].status == criteria_core.STATUS_STRONG
    assert by_name["function"].positives[0].phrase == "backend coding"
    assert by_name["compensation"].status == criteria_core.STATUS_VIOLATION
    assert check.violations[0].dimension == "compensation"
    assert check.summary == "Mixed verdict overall."
    assert {d.name for d in check.dimensions} == set(criteria_core.DIMENSIONS)


def test_check_invalid_status_falls_back_to_unknown(ws: Path) -> None:
    opp = _make_opportunity(ws)
    resp = _check_response(dimensions=[_dim("function", "amazing")])
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    function_dim = next(d for d in check.dimensions if d.name == "function")
    assert function_dim.status == criteria_core.STATUS_UNKNOWN


def test_check_ignores_unknown_dimensions(ws: Path) -> None:
    opp = _make_opportunity(ws)
    resp = _check_response(
        dimensions=[_dim("bogus", "strong",
                         violations=[{"phrase": "should not appear", "context": ""}])],
        summary="ok",
    )
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    assert check.violations == ()
    assert check.summary == "ok"


def test_check_raises_on_invalid_json(ws: Path) -> None:
    opp = _make_opportunity(ws)
    with patch(PATCH_COMPLETE_JSON, side_effect=LLMAPIError("invalid JSON")):
        with pytest.raises(LLMAPIError, match="invalid JSON"):
            criteria_core.check_against_opportunity({}, opp, _llm_config())


def test_check_tolerates_trailing_fence(ws: Path) -> None:
    opp = _make_opportunity(ws)
    resp = _check_response(summary="looks fine")
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    assert check.summary == "looks fine"


# --- CLI: career criteria show ---


def test_cli_criteria_show_flags_empty_after_init(ws_cd: Path) -> None:
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 0, result.output
    assert "empty" in result.output.lower()
    assert "Incomplete dimensions" in result.output


def test_cli_criteria_show_renders_filled_fields(ws_cd: Path) -> None:
    criteria_core.save_criteria(
        ws_cd,
        {
            "function": {
                "want": ["backend coding"], "dread": [],
                "dealbreakers": ["no coding at all"],
            },
            "culture": {"preferred": [], "avoid": [], "dealbreakers": []},
            "growth": {
                "goal_2_3_years": "staff engineer",
                "motivators": [], "stuck_signals": [], "dealbreakers": [],
            },
            "compensation": {
                "base_minimum": 150000, "base_target": 180000,
                "currency": "USD", "other_important": [], "dealbreakers": [],
            },
            "location": {
                "preferred": ["Remote (US)"], "willing_to_relocate": False,
                "work_type": "remote", "constraints": [], "dealbreakers": [],
            },
        },
    )
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 0, result.output
    for expected in ("backend coding", "staff engineer", "150000", "180000", "Remote (US)"):
        assert expected in result.output


def test_cli_criteria_show_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 2


# --- CLI: career criteria edit ---


_INTERACTIVE_PROMPT_COUNT = 20


def test_cli_criteria_edit_interactive_keeps_defaults(ws_cd: Path) -> None:
    result = runner.invoke(
        app, ["criteria", "edit"], input="\n" * _INTERACTIVE_PROMPT_COUNT,
    )
    assert result.exit_code == 0, result.output
    assert "Saved criteria.yml" in result.output
    data = criteria_core.load_criteria(ws_cd)
    for dim in criteria_core.DIMENSIONS:
        assert isinstance(data.get(dim), dict)
    assert data["compensation"]["currency"] == "USD"
    assert data["location"]["willing_to_relocate"] is False


def test_cli_criteria_edit_interactive_saves_user_inputs(ws_cd: Path) -> None:
    answers = "\n".join([
        "hands-on backend coding, system design",
        "pure people management",
        "no coding at all",
        "async-first, small team",
        "meeting-heavy",
        "mandatory in-office",
        "staff engineer",
        "hard technical problems",
        "no promotion path",
        "no learning budget",
        "150000", "180000", "USD",
        "equity, 20+ PTO days",
        "no health insurance",
        "Remote (US)", "n", "remote",
        "need US work auth",
        "fully in-person required",
    ]) + "\n"
    result = runner.invoke(app, ["criteria", "edit"], input=answers)
    assert result.exit_code == 0, result.output

    data = criteria_core.load_criteria(ws_cd)
    assert data["function"]["want"] == ["hands-on backend coding", "system design"]
    assert data["function"]["dealbreakers"] == ["no coding at all"]
    assert data["growth"]["goal_2_3_years"] == "staff engineer"
    assert data["compensation"]["base_minimum"] == 150000
    assert data["compensation"]["base_target"] == 180000
    assert data["location"]["willing_to_relocate"] is False
    assert data["location"]["work_type"] == "remote"


def test_cli_criteria_edit_interactive_dash_clears_list(ws_cd: Path) -> None:
    criteria_core.save_criteria(
        ws_cd,
        {"function": {"want": ["coding"], "dread": [], "dealbreakers": []}},
    )
    answers = "-" + "\n" * _INTERACTIVE_PROMPT_COUNT
    result = runner.invoke(app, ["criteria", "edit"], input=answers)
    assert result.exit_code == 0, result.output
    assert criteria_core.load_criteria(ws_cd)["function"]["want"] == []


def test_cli_criteria_edit_with_editor_flag(ws_cd: Path) -> None:
    captured: list[Path] = []

    def fake_open(file_path: Path, editor: str) -> int:
        captured.append(file_path)
        return 0

    with patch.object(common_cmd, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(app, ["criteria", "edit", "--editor"])
    assert result.exit_code == 0, result.output
    assert captured == [ws_cd / "criteria.yml"]


def test_cli_criteria_edit_with_editor_flag_handles_missing_editor(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EDITOR", "stub-editor")
    with patch.object(
        common_cmd, "open_in_editor",
        side_effect=FileNotFoundError("missing"),
    ):
        result = runner.invoke(app, ["criteria", "edit", "--editor"])
    assert result.exit_code == 1
    assert "editor not found" in result.output.lower()


def test_cli_criteria_edit_with_editor_flag_creates_file_when_missing(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    (ws_cd / "criteria.yml").unlink()
    monkeypatch.setenv("EDITOR", "stub-editor")
    with patch.object(common_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(app, ["criteria", "edit", "--editor"])
    assert result.exit_code == 0, result.output
    assert (ws_cd / "criteria.yml").exists()


def test_cli_criteria_edit_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "edit"])
    assert result.exit_code == 2
    result_editor = runner.invoke(app, ["criteria", "edit", "--editor"])
    assert result_editor.exit_code == 2


# --- CLI: career criteria check ---


def test_cli_criteria_check_reports_no_violations(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _setup_criteria_and_opp(ws, monkeypatch)
    _enable_llm(ws, monkeypatch)
    resp = _check_response(
        dimensions=[_dim("function", "strong", "Coding role.",
                         positives=[{"phrase": "backend coding", "context": "Backend role."}])],
        summary="Solid fit.",
    )
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "0 dealbreaker violations" in result.output
    assert "backend coding" in result.output
    assert "Solid fit" in result.output


def test_cli_criteria_check_reports_violations(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _setup_criteria_and_opp(ws, monkeypatch)
    _enable_llm(ws, monkeypatch)
    resp = _check_response(
        dimensions=[_dim("function", "violation", "Pure management role.",
                         violations=[{"phrase": "no coding at all", "context": "pure management."}])],
        summary="Poor fit.",
    )
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 0, result.output
    assert "Dealbreaker violations" in result.output
    assert "no coding at all" in result.output


def test_cli_criteria_check_missing_opportunity_exit_1(
    ws_cd: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _enable_llm(ws_cd, monkeypatch)
    criteria_core.save_criteria(ws_cd, BASIC_CRITERIA)
    result = runner.invoke(app, ["criteria", "check", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_criteria_check_empty_criteria_exit_1(ws_cd: Path) -> None:
    (ws_cd / "criteria.yml").write_text("", encoding="utf-8")
    runner.invoke(app, ["opportunity", "add", "X", "--no-editor"])
    result = runner.invoke(app, ["criteria", "check", "x"])
    assert result.exit_code == 1
    assert "no criteria" in result.output.lower()


def test_cli_criteria_check_disambiguates_multiple_matches(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(ws)
    _enable_llm(ws, monkeypatch)
    criteria_core.save_criteria(ws, BASIC_CRITERIA)
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"])
    runner.invoke(app, ["opportunity", "add", "Senior Engineer at Globex", "--no-editor"])
    resp = _check_response()
    with patch(PATCH_COMPLETE_JSON, return_value=resp):
        result = runner.invoke(app, ["criteria", "check", "engineer"], input="1\n")
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


def test_cli_criteria_check_missing_llm_config_exits_3(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _setup_criteria_and_opp(ws, monkeypatch)
    result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 3
    assert "config.yml" in result.output


def test_cli_criteria_check_llm_failure_exits_1(
    ws: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _setup_criteria_and_opp(ws, monkeypatch)
    _enable_llm(ws, monkeypatch)
    with patch(PATCH_COMPLETE_JSON, side_effect=LLMAPIError("HTTP 500")):
        result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 1
    assert "llm check failed" in result.output.lower()


def test_cli_criteria_check_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "check", "x"])
    assert result.exit_code == 2