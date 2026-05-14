"""Tests for the criteria module and the `career criteria` CLI."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import _common as common_cmd
from career_planner.core import criteria as criteria_core
from career_planner.core import llm as llm_core
from career_planner.core import opportunities as opp_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})


# --- core/criteria.py: file I/O ---


def test_criteria_path_points_at_workspace_root(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert criteria_core.criteria_path(ws) == ws / "criteria.yml"


def test_load_criteria_returns_empty_dict_when_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    assert criteria_core.load_criteria(ws) == {}


def test_load_criteria_reads_template_after_init(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    data = criteria_core.load_criteria(ws)
    for dim in criteria_core.DIMENSIONS:
        assert dim in data


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    payload = {
        "function": {"want": ["coding"], "dread": [], "dealbreakers": []},
        "compensation": {"base_minimum": 150000, "base_target": 180000},
    }
    criteria_core.save_criteria(ws, payload)
    assert criteria_core.load_criteria(ws) == payload


# --- dimension introspection ---


def test_is_dimension_empty_true_for_fresh_template(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
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
    """Unknown dimensions must not drag the alignment ratio down."""
    check = criteria_core.CriteriaCheck(
        opportunity_slug="x",
        opportunity_title="X",
        dimensions=(
            criteria_core.DimensionResult(
                name="function",
                status=criteria_core.STATUS_STRONG,
                positives=(),
                negatives=(),
                violations=(),
            ),
            criteria_core.DimensionResult(
                name="culture",
                status=criteria_core.STATUS_UNKNOWN,
                positives=(),
                negatives=(),
                violations=(),
            ),
        ),
    )
    assert check.alignment == 1.0


# --- check_against_opportunity: response parsing ---


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


def _llm_config() -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def test_check_parses_full_response(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws, body="Backend role.")
    response = (
        '{"dimensions": ['
        '  {"name": "function", "status": "strong", '
        '   "summary": "Coding-heavy role.", '
        '   "positives": [{"phrase": "backend coding", "context": "Backend role."}], '
        '   "negatives": [], "violations": []},'
        '  {"name": "compensation", "status": "violation", '
        '   "summary": "Below floor.", '
        '   "positives": [], "negatives": [], '
        '   "violations": [{"phrase": "salary below floor", "context": "90k"}]}'
        '], "summary": "Mixed verdict overall."}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=response):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())

    by_name = {d.name: d for d in check.dimensions}
    assert by_name["function"].status == criteria_core.STATUS_STRONG
    assert by_name["function"].positives[0].phrase == "backend coding"
    assert by_name["compensation"].status == criteria_core.STATUS_VIOLATION
    assert check.violations[0].dimension == "compensation"
    assert check.summary == "Mixed verdict overall."
    # All five dimensions are always present (filled with unknown if absent).
    assert {d.name for d in check.dimensions} == set(criteria_core.DIMENSIONS)


def test_check_invalid_status_falls_back_to_unknown(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws)
    response = (
        '{"dimensions": [{"name": "function", "status": "amazing", '
        '"summary": "", "positives": [], "negatives": [], "violations": []}]}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=response):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    function_dim = next(d for d in check.dimensions if d.name == "function")
    assert function_dim.status == criteria_core.STATUS_UNKNOWN


def test_check_ignores_unknown_dimensions(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws)
    response = (
        '{"dimensions": [{"name": "bogus", "status": "strong", '
        '"violations": [{"phrase": "should not appear", "context": ""}]}], '
        '"summary": "ok"}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=response):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    assert check.violations == ()
    assert check.summary == "ok"


def test_check_raises_on_invalid_json(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws)
    with patch.object(criteria_core.llm, "complete", return_value="not json"):
        with pytest.raises(llm_core.LLMAPIError, match="invalid JSON"):
            criteria_core.check_against_opportunity({}, opp, _llm_config())


def test_check_tolerates_trailing_fence(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws)
    response = '{"dimensions": [], "summary": "looks fine"}\n```'
    with patch.object(criteria_core.llm, "complete", return_value=response):
        check = criteria_core.check_against_opportunity({}, opp, _llm_config())
    assert check.summary == "looks fine"


# --- CLI: career criteria show ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_criteria_show_flags_empty_after_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 0, result.output
    assert "empty" in result.output.lower()
    assert "Incomplete dimensions" in result.output


def test_cli_criteria_show_renders_filled_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {
            "function": {
                "want": ["backend coding"],
                "dread": [],
                "dealbreakers": ["no coding at all"],
            },
            "culture": {"preferred": [], "avoid": [], "dealbreakers": []},
            "growth": {
                "goal_2_3_years": "staff engineer",
                "motivators": [],
                "stuck_signals": [],
                "dealbreakers": [],
            },
            "compensation": {
                "base_minimum": 150000,
                "base_target": 180000,
                "currency": "USD",
                "other_important": [],
                "dealbreakers": [],
            },
            "location": {
                "preferred": ["Remote (US)"],
                "willing_to_relocate": False,
                "work_type": "remote",
                "constraints": [],
                "dealbreakers": [],
            },
        },
    )
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 0, result.output
    assert "backend coding" in result.output
    assert "staff engineer" in result.output
    assert "150000" in result.output
    assert "180000" in result.output
    assert "Remote (US)" in result.output


def test_cli_criteria_show_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "show"])
    assert result.exit_code == 2


# --- CLI: career criteria edit ---


# The interactive prompt walks every field in every dimension, so a default
# "press Enter for everything" run consumes one blank line per prompt.
_INTERACTIVE_PROMPT_COUNT = 20


def _accept_all_defaults() -> str:
    return "\n" * _INTERACTIVE_PROMPT_COUNT


def test_cli_criteria_edit_interactive_keeps_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["criteria", "edit"], input=_accept_all_defaults())
    assert result.exit_code == 0, result.output
    assert "Saved criteria.yml" in result.output

    data = criteria_core.load_criteria(ws)
    for dim in criteria_core.DIMENSIONS:
        assert isinstance(data.get(dim), dict)
    assert data["compensation"]["currency"] == "USD"
    assert data["location"]["willing_to_relocate"] is False


def test_cli_criteria_edit_interactive_saves_user_inputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    answers = [
        "hands-on backend coding, system design",  # function.want
        "pure people management",                    # function.dread
        "no coding at all",                          # function.dealbreakers
        "async-first, small team",                   # culture.preferred
        "meeting-heavy",                             # culture.avoid
        "mandatory in-office",                       # culture.dealbreakers
        "staff engineer",                            # growth.goal_2_3_years
        "hard technical problems",                   # growth.motivators
        "no promotion path",                         # growth.stuck_signals
        "no learning budget",                        # growth.dealbreakers
        "150000",                                    # compensation.base_minimum
        "180000",                                    # compensation.base_target
        "USD",                                       # compensation.currency
        "equity, 20+ PTO days",                      # compensation.other_important
        "no health insurance",                       # compensation.dealbreakers
        "Remote (US)",                               # location.preferred
        "n",                                         # location.willing_to_relocate
        "remote",                                    # location.work_type
        "need US work auth",                         # location.constraints
        "fully in-person required",                  # location.dealbreakers
    ]
    result = runner.invoke(
        app, ["criteria", "edit"], input="\n".join(answers) + "\n"
    )
    assert result.exit_code == 0, result.output

    data = criteria_core.load_criteria(ws)
    assert data["function"]["want"] == ["hands-on backend coding", "system design"]
    assert data["function"]["dealbreakers"] == ["no coding at all"]
    assert data["growth"]["goal_2_3_years"] == "staff engineer"
    assert data["compensation"]["base_minimum"] == 150000
    assert data["compensation"]["base_target"] == 180000
    assert data["compensation"]["other_important"] == ["equity", "20+ PTO days"]
    assert data["location"]["preferred"] == ["Remote (US)"]
    assert data["location"]["willing_to_relocate"] is False
    assert data["location"]["work_type"] == "remote"


def test_cli_criteria_edit_interactive_dash_clears_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {
            "function": {
                "want": ["coding"],
                "dread": [],
                "dealbreakers": [],
            }
        },
    )
    answers = ["-"] + [""] * (_INTERACTIVE_PROMPT_COUNT - 1)
    result = runner.invoke(
        app, ["criteria", "edit"], input="\n".join(answers) + "\n"
    )
    assert result.exit_code == 0, result.output

    data = criteria_core.load_criteria(ws)
    assert data["function"]["want"] == []


def test_cli_criteria_edit_with_editor_flag(
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
        result = runner.invoke(app, ["criteria", "edit", "--editor"])

    assert result.exit_code == 0, result.output
    assert captured == [ws / "criteria.yml"]


def test_cli_criteria_edit_with_editor_flag_handles_missing_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(
        common_cmd,
        "open_in_editor",
        side_effect=FileNotFoundError("missing"),
    ):
        result = runner.invoke(app, ["criteria", "edit", "--editor"])

    assert result.exit_code == 1
    assert "editor not found" in result.output.lower()


def test_cli_criteria_edit_with_editor_flag_creates_file_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    (ws / "criteria.yml").unlink()
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(common_cmd, "open_in_editor", return_value=0):
        result = runner.invoke(app, ["criteria", "edit", "--editor"])

    assert result.exit_code == 0, result.output
    assert (ws / "criteria.yml").exists()


def test_cli_criteria_edit_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "edit"])
    assert result.exit_code == 2

    result_editor = runner.invoke(app, ["criteria", "edit", "--editor"])
    assert result_editor.exit_code == 2


# --- CLI: career criteria check (always AI) ---


def _setup_llm(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (workspace / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")


def _setup_workspace_with_criteria(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {
            "function": {
                "want": ["coding"],
                "dread": [],
                "dealbreakers": ["no coding at all"],
            }
        },
    )
    runner.invoke(
        app, ["opportunity", "add", "Engineer at Acme", "--no-editor"]
    )
    return ws


def test_cli_criteria_check_reports_no_violations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _setup_workspace_with_criteria(tmp_path, monkeypatch)
    _setup_llm(ws, monkeypatch)
    response = (
        '{"dimensions": [{"name": "function", "status": "strong", '
        '"summary": "Coding role.", '
        '"positives": [{"phrase": "backend coding", "context": "Backend role."}], '
        '"negatives": [], "violations": []}], '
        '"summary": "Solid fit."}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=response):
        result = runner.invoke(
            app, ["criteria", "check", "engineer-at-acme"]
        )
    assert result.exit_code == 0, result.output
    assert "0 dealbreaker violations" in result.output
    assert "backend coding" in result.output
    assert "Solid fit" in result.output


def test_cli_criteria_check_reports_violations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _setup_workspace_with_criteria(tmp_path, monkeypatch)
    _setup_llm(ws, monkeypatch)
    response = (
        '{"dimensions": [{"name": "function", "status": "violation", '
        '"summary": "Pure management role.", '
        '"positives": [], "negatives": [], '
        '"violations": [{"phrase": "no coding at all", "context": "pure management."}]}], '
        '"summary": "Poor fit."}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=response):
        result = runner.invoke(
            app, ["criteria", "check", "engineer-at-acme"]
        )
    assert result.exit_code == 0, result.output
    assert "Dealbreaker violations" in result.output
    assert "no coding at all" in result.output


def test_cli_criteria_check_missing_opportunity_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _setup_llm(ws, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {"function": {"want": ["coding"], "dread": [], "dealbreakers": []}},
    )
    result = runner.invoke(app, ["criteria", "check", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_criteria_check_empty_criteria_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    (ws / "criteria.yml").write_text("", encoding="utf-8")
    runner.invoke(app, ["opportunity", "add", "X", "--no-editor"])
    result = runner.invoke(app, ["criteria", "check", "x"])
    assert result.exit_code == 1
    assert "no criteria" in result.output.lower()


def test_cli_criteria_check_disambiguates_multiple_matches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _setup_llm(ws, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {"function": {"want": ["coding"], "dread": [], "dealbreakers": []}},
    )
    runner.invoke(
        app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"]
    )
    runner.invoke(
        app, ["opportunity", "add", "Senior Engineer at Globex", "--no-editor"]
    )
    response = '{"dimensions": [], "summary": ""}'
    with patch.object(criteria_core.llm, "complete", return_value=response):
        result = runner.invoke(
            app, ["criteria", "check", "engineer"], input="1\n"
        )
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


def test_cli_criteria_check_missing_llm_config_exits_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup_workspace_with_criteria(tmp_path, monkeypatch)
    # config.yml from `career init` has no llm block.
    result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 3
    assert "config.yml" in result.output


def test_cli_criteria_check_llm_failure_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _setup_workspace_with_criteria(tmp_path, monkeypatch)
    _setup_llm(ws, monkeypatch)
    with patch.object(
        criteria_core.llm,
        "complete",
        side_effect=llm_core.LLMAPIError("HTTP 500"),
    ):
        result = runner.invoke(app, ["criteria", "check", "engineer-at-acme"])
    assert result.exit_code == 1
    assert "llm check failed" in result.output.lower()


def test_cli_criteria_check_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "check", "x"])
    assert result.exit_code == 2
