"""Tests for the criteria module and the `career criteria` CLI."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
import yaml
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import criteria as criteria_cmd
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


# --- check_against_opportunity: dealbreakers ---


def _make_opportunity(
    workspace: Path,
    *,
    title: str = "Senior Engineer at Acme",
    body: str = "",
    extra: dict | None = None,
) -> opp_core.Opportunity:
    path = opp_core.create_opportunity(workspace, title=title, extra=extra)
    if body:
        text = path.read_text(encoding="utf-8")
        front, current_body = opp_core.parse_markdown(text)
        new_body = current_body + "\n## Description\n\n" + body + "\n"
        path.write_text(
            opp_core.serialize_markdown(front, new_body), encoding="utf-8"
        )
    return opp_core.load_opportunity(workspace, path.stem)


def test_check_flags_dealbreaker_in_description(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "function": {
            "want": [],
            "dread": [],
            "dealbreakers": ["no coding at all"],
        }
    }
    opp = _make_opportunity(
        ws,
        body="This role has no coding at all — pure management.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    assert result.has_violations
    assert len(result.violations) == 1
    violation = result.violations[0]
    assert violation.dimension == "function"
    assert violation.source == "dealbreaker"
    assert "no coding at all" in violation.phrase
    assert "no coding at all" in violation.context.lower()


def test_check_dealbreaker_phrase_word_bounded(tmp_path: Path) -> None:
    """A dealbreaker phrase must be word-bounded — substrings don't trigger."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "culture": {
            "preferred": [],
            "avoid": [],
            "dealbreakers": ["micromanagement"],
        }
    }
    opp = _make_opportunity(
        ws,
        body="We value autonomy and avoid undermicromanagementtrap policies.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    assert not result.has_violations


def test_check_no_violations_when_opportunity_is_clean(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "function": {
            "want": ["backend coding"],
            "dread": [],
            "dealbreakers": ["no coding at all"],
        }
    }
    opp = _make_opportunity(
        ws,
        body="Senior backend coding role with great tools.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    assert not result.has_violations
    function_dim = next(
        d for d in result.dimensions if d.name == "function"
    )
    assert function_dim.status in (criteria_core.STATUS_OK, criteria_core.STATUS_STRONG)
    assert [p.phrase for p in function_dim.positives] == ["backend coding"]


# --- compensation structured check ---


def test_check_salary_below_floor_is_violation(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {
            "base_minimum": 150000,
            "base_target": 180000,
            "currency": "USD",
        }
    }
    opp = _make_opportunity(
        ws,
        extra={
            "salary_min": 90000,
            "salary_max": 110000,
            "salary_currency": "USD",
        },
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_VIOLATION
    assert any(v.source == "salary_floor" for v in comp.violations)


def test_check_salary_meets_target_is_strong(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {
            "base_minimum": 150000,
            "base_target": 180000,
            "currency": "USD",
        }
    }
    opp = _make_opportunity(
        ws,
        extra={
            "salary_min": 190000,
            "salary_max": 220000,
            "salary_currency": "USD",
        },
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_STRONG
    assert not comp.violations


def test_check_salary_clears_floor_but_below_target_is_ok(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {"base_minimum": 150000, "base_target": 180000}
    }
    opp = _make_opportunity(
        ws,
        extra={"salary_min": 160000, "salary_max": 170000},
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_OK
    assert not comp.violations


def test_check_compensation_with_no_salary_is_unknown(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {"base_minimum": 150000, "base_target": 180000}
    }
    opp = _make_opportunity(ws)  # no salary in extra
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_UNKNOWN
    assert any("no salary listed" in note for note in comp.notes)


def test_check_compensation_currency_mismatch_noted(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {
            "base_minimum": 150000,
            "base_target": 180000,
            "currency": "USD",
        }
    }
    opp = _make_opportunity(
        ws,
        extra={
            "salary_min": 200000,
            "salary_max": 220000,
            "salary_currency": "EUR",
        },
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert any("currency mismatch" in note for note in comp.notes)


# --- location structured check ---


def test_check_location_work_type_mismatch_is_violation(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "remote"}}
    opp = _make_opportunity(ws, extra={"work_type": "in-person"})
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert loc.status == criteria_core.STATUS_VIOLATION
    assert any(v.source == "work_type" for v in loc.violations)


def test_check_location_work_type_match_no_violation(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "remote"}}
    opp = _make_opportunity(ws, extra={"work_type": "remote"})
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert not loc.violations
    assert any("matches criteria" in note for note in loc.notes)


def test_check_location_hybrid_accepts_remote(tmp_path: Path) -> None:
    """``work_type: hybrid`` in criteria should accept a remote opportunity."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "hybrid"}}
    opp = _make_opportunity(ws, extra={"work_type": "remote"})
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert not loc.violations


# --- dimension status classification ---


def test_dimension_status_unknown_for_empty_criteria(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws, body="Anything at all.")
    result = criteria_core.check_against_opportunity({}, opp)
    for dim in result.dimensions:
        assert dim.status == criteria_core.STATUS_UNKNOWN


def test_dimension_status_weak_when_negatives_outweigh(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "culture": {
            "preferred": ["async-first"],
            "avoid": ["meeting-heavy", "micromanagement"],
            "dealbreakers": [],
        }
    }
    opp = _make_opportunity(
        ws,
        body="Our culture is meeting-heavy with constant micromanagement.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    culture = next(d for d in result.dimensions if d.name == "culture")
    assert culture.status == criteria_core.STATUS_WEAK
    assert len(culture.negatives) == 2
    assert culture.positives == ()


# --- body-text inference (salary + work_type) ---


def test_check_infers_salary_from_description(tmp_path: Path) -> None:
    """A posting with no salary frontmatter but a "$150K-$200K" in the body
    should still trigger the structured floor/target checks."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {
            "base_minimum": 150_000,
            "base_target": 180_000,
            "currency": "USD",
        }
    }
    opp = _make_opportunity(
        ws,
        body="Compensation: $190K-$220K plus equity and benefits.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_STRONG
    assert not comp.violations
    assert any("inferred from description" in note for note in comp.notes)


def test_check_infers_salary_below_floor_is_violation(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "compensation": {"base_minimum": 150_000, "base_target": 180_000}
    }
    opp = _make_opportunity(
        ws,
        body="Salary range $80K-$120K depending on experience.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_VIOLATION
    assert any(v.source == "salary_floor" for v in comp.violations)
    assert any("inferred from description" in note for note in comp.notes)


def test_check_frontmatter_salary_wins_over_body(tmp_path: Path) -> None:
    """When the frontmatter has a salary, the body text isn't consulted —
    so the "inferred" note must not appear."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"compensation": {"base_minimum": 150_000, "base_target": 180_000}}
    opp = _make_opportunity(
        ws,
        body="Earlier the post said $50K-$60K but the offer is higher.",
        extra={"salary_min": 200_000, "salary_max": 250_000, "salary_currency": "USD"},
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    comp = next(d for d in result.dimensions if d.name == "compensation")
    assert comp.status == criteria_core.STATUS_STRONG
    assert not any("inferred" in note for note in comp.notes)


def test_check_infers_work_type_from_description(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "remote"}}
    opp = _make_opportunity(
        ws,
        body="This is a fully remote role open to candidates in the US.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert not loc.violations
    assert any("inferred from description" in note for note in loc.notes)
    assert any("matches criteria" in note for note in loc.notes)


def test_check_infers_in_person_violates_remote_criteria(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "remote"}}
    opp = _make_opportunity(
        ws,
        body="This is a fully in-person team with 5 days a week in office.",
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert loc.status == criteria_core.STATUS_VIOLATION
    assert any(v.source == "work_type" for v in loc.violations)
    assert any("inferred from description" in note for note in loc.notes)


def test_check_frontmatter_work_type_wins_over_body(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"location": {"work_type": "remote"}}
    # Frontmatter says remote — body's "hybrid" should be ignored.
    opp = _make_opportunity(
        ws,
        body="The wider company is hybrid but this role is different.",
        extra={"work_type": "remote"},
    )
    result = criteria_core.check_against_opportunity(criteria, opp)
    loc = next(d for d in result.dimensions if d.name == "location")
    assert not loc.violations
    assert not any("inferred" in note for note in loc.notes)


# --- alignment & overall ---


def test_alignment_excludes_unknown_dimensions(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    # Only function is filled in; the other four dimensions stay unknown
    # and must not drag the alignment ratio down.
    criteria = {
        "function": {
            "want": ["coding"],
            "dread": [],
            "dealbreakers": [],
        }
    }
    opp = _make_opportunity(ws, body="Lots of coding here.")
    result = criteria_core.check_against_opportunity(criteria, opp)
    assert result.alignment == 1.0


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
    # Every dimension is empty in the template, so each gets the warning.
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


# The interactive prompt walks through every field in every dimension, so a
# default "press Enter for everything" run consumes one blank line per prompt.
# The bool prompt (location.willing_to_relocate) also accepts an empty line as
# "use the default".
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
    # All five dimensions should still be present after a no-op interactive edit.
    for dim in criteria_core.DIMENSIONS:
        assert isinstance(data.get(dim), dict)
    # Defaults from the template should round-trip unchanged.
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
    # Seed a value so we can prove '-' wipes it.
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
        criteria_cmd.profile_core, "open_in_editor", side_effect=fake_open
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
        criteria_cmd.profile_core,
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

    with patch.object(criteria_cmd.profile_core, "open_in_editor", return_value=0):
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


# --- CLI: career criteria check ---


def test_cli_criteria_check_reports_no_violations(
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
            }
        },
    )
    runner.invoke(
        app, ["opportunity", "add", "Senior Engineer at Acme", "--no-editor"]
    )
    path = ws / "opportunities" / "senior-engineer-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    body = body + "\n## Description\n\nSenior backend coding role.\n"
    path.write_text(
        opp_core.serialize_markdown(front, body), encoding="utf-8"
    )

    result = runner.invoke(
        app, ["criteria", "check", "senior-engineer-at-acme"]
    )
    assert result.exit_code == 0, result.output
    assert "0 dealbreaker violations" in result.output
    # The matched positive phrase shows up in the dimension details panel.
    assert "backend coding" in result.output


def test_cli_criteria_check_reports_violations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    criteria_core.save_criteria(
        ws,
        {
            "function": {
                "want": [],
                "dread": [],
                "dealbreakers": ["no coding at all"],
            },
            "compensation": {"base_minimum": 150000, "base_target": 180000},
        },
    )
    runner.invoke(
        app, ["opportunity", "add", "Manager Role at Acme", "--no-editor"]
    )
    path = ws / "opportunities" / "manager-role-at-acme.md"
    front, body = opp_core.parse_markdown(path.read_text(encoding="utf-8"))
    front["salary_min"] = 90000
    front["salary_max"] = 110000
    body = body + "\n## Description\n\nThis is no coding at all — pure management.\n"
    path.write_text(
        opp_core.serialize_markdown(front, body), encoding="utf-8"
    )

    result = runner.invoke(
        app, ["criteria", "check", "manager-role-at-acme"]
    )
    assert result.exit_code == 0, result.output
    assert "Dealbreaker violations" in result.output
    assert "no coding at all" in result.output
    assert "salary_floor" in result.output


def test_cli_criteria_check_missing_opportunity_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
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
    result = runner.invoke(
        app, ["criteria", "check", "engineer"], input="1\n"
    )
    assert result.exit_code == 0, result.output
    assert "Multiple opportunities match" in result.output


def test_cli_criteria_check_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["criteria", "check", "x"])
    assert result.exit_code == 2


# --- LLM augmentation (core/criteria.augment_with_llm) ---


def _llm_config() -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def test_augment_with_llm_merges_findings(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "function": {
            "want": ["backend coding"],
            "dread": [],
            "dealbreakers": ["no coding at all"],
        }
    }
    opp = _make_opportunity(
        ws,
        body="This role is primarily about people management with little hands-on engineering work.",
    )
    base = criteria_core.check_against_opportunity(criteria, opp)

    llm_response = (
        '{"dimensions": [{"name": "function", "summary": "The role is '
        'management-heavy with limited coding.", "additional_violations": '
        '[{"phrase": "minimal coding in this role", "context": "primarily '
        'about people management with little hands-on engineering"}], '
        '"additional_positives": [], "additional_negatives": []}], '
        '"overall_summary": "Likely a poor fit given the user\'s coding '
        'preference."}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=llm_response):
        augmented = criteria_core.augment_with_llm(
            base, criteria, opp, _llm_config()
        )

    function_dim = next(d for d in augmented.dimensions if d.name == "function")
    assert function_dim.status == criteria_core.STATUS_VIOLATION
    assert any(v.source == "llm" for v in function_dim.violations)
    assert function_dim.ai_note == (
        "The role is management-heavy with limited coding."
    )
    assert "poor fit" in augmented.ai_summary
    assert augmented.ai_augmented


def test_augment_with_llm_preserves_existing_violations(tmp_path: Path) -> None:
    """LLM violations append to literal ones, not replace them."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {
        "function": {
            "want": [],
            "dread": [],
            "dealbreakers": ["no coding at all"],
        }
    }
    opp = _make_opportunity(
        ws,
        body="This is no coding at all — pure management. Also: 60-hour weeks.",
    )
    base = criteria_core.check_against_opportunity(criteria, opp)
    assert len(base.violations) == 1  # literal hit on the dealbreaker

    llm_response = (
        '{"dimensions": [{"name": "function", "summary": "Burnout risk.", '
        '"additional_violations": [{"phrase": "60-hour weeks", "context": '
        '"Also: 60-hour weeks"}], "additional_positives": [], '
        '"additional_negatives": []}]}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=llm_response):
        augmented = criteria_core.augment_with_llm(
            base, criteria, opp, _llm_config()
        )

    function_dim = next(d for d in augmented.dimensions if d.name == "function")
    sources = sorted({v.source for v in function_dim.violations})
    assert sources == ["dealbreaker", "llm"]


def test_augment_with_llm_ignores_unknown_dimensions(tmp_path: Path) -> None:
    """A bogus dimension name in the LLM response is silently dropped."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"function": {"want": ["coding"], "dread": [], "dealbreakers": []}}
    opp = _make_opportunity(ws, body="Backend coding role.")
    base = criteria_core.check_against_opportunity(criteria, opp)

    llm_response = (
        '{"dimensions": [{"name": "bogus_dimension", "summary": "ignored", '
        '"additional_violations": [{"phrase": "should not appear", '
        '"context": ""}]}], "overall_summary": "ok"}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=llm_response):
        augmented = criteria_core.augment_with_llm(
            base, criteria, opp, _llm_config()
        )

    assert all(
        not any(v.source == "llm" for v in d.violations)
        for d in augmented.dimensions
    )
    assert augmented.ai_summary == "ok"


def test_augment_with_llm_raises_on_invalid_json(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    opp = _make_opportunity(ws, body="anything")
    base = criteria_core.check_against_opportunity({}, opp)
    with patch.object(criteria_core.llm, "complete", return_value="not json at all"):
        with pytest.raises(llm_core.LLMAPIError, match="invalid JSON"):
            criteria_core.augment_with_llm(base, {}, opp, _llm_config())


def test_augment_with_llm_strips_trailing_fence(tmp_path: Path) -> None:
    """Sometimes the model adds a stray ```...``` fence — we should tolerate it."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    criteria = {"function": {"want": ["coding"], "dread": [], "dealbreakers": []}}
    opp = _make_opportunity(ws, body="Coding role.")
    base = criteria_core.check_against_opportunity(criteria, opp)

    llm_response = (
        '{"dimensions": [], "overall_summary": "looks fine"}\n```'
    )
    with patch.object(criteria_core.llm, "complete", return_value=llm_response):
        augmented = criteria_core.augment_with_llm(
            base, criteria, opp, _llm_config()
        )
    assert augmented.ai_summary == "looks fine"


# --- CLI: career criteria check --reason ---


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


def test_cli_criteria_check_reason_calls_llm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _setup_workspace_with_criteria(tmp_path, monkeypatch)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")

    llm_response = (
        '{"dimensions": [{"name": "function", "summary": '
        '"Role looks suitable for a coder."}], '
        '"overall_summary": "Solid fit overall."}'
    )
    with patch.object(criteria_core.llm, "complete", return_value=llm_response):
        result = runner.invoke(
            app, ["criteria", "check", "engineer-at-acme", "--reason"]
        )

    assert result.exit_code == 0, result.output
    assert "AI reasoning" in result.output
    assert "Solid fit overall" in result.output
    assert "Role looks suitable for a coder" in result.output


def test_cli_criteria_check_reason_missing_config_exits_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup_workspace_with_criteria(tmp_path, monkeypatch)
    # config.yml from `career init` has no llm block.
    result = runner.invoke(
        app, ["criteria", "check", "engineer-at-acme", "--reason"]
    )
    assert result.exit_code == 3
    assert "--reason" in result.output
    assert "config.yml" in result.output


def test_cli_criteria_check_reason_api_failure_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An API error mid-call shouldn't kill the command — print a warning
    and emit the pure-software result so the user still has something."""
    ws = _setup_workspace_with_criteria(tmp_path, monkeypatch)
    (ws / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")

    with patch.object(
        criteria_core.llm,
        "complete",
        side_effect=llm_core.LLMAPIError("HTTP 500"),
    ):
        result = runner.invoke(
            app, ["criteria", "check", "engineer-at-acme", "--reason"]
        )

    assert result.exit_code == 0, result.output
    assert "augmentation failed" in result.output.lower()
    # The dimension alignment table from the pure-software check is still
    # rendered, so the user gets actionable output even when AI fails.
    assert "Dimension alignment" in result.output


def test_cli_criteria_check_without_reason_skips_llm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`criteria check` without `--reason` must never call the LLM."""
    _setup_workspace_with_criteria(tmp_path, monkeypatch)
    with patch.object(criteria_core.llm, "complete") as mock_complete:
        result = runner.invoke(
            app, ["criteria", "check", "engineer-at-acme"]
        )
    assert result.exit_code == 0
    mock_complete.assert_not_called()
    assert "AI reasoning" not in result.output
