"""Tests for the resume module and the `career resume` CLI."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from career_planner.cli import app
from career_planner.commands import _common as common_cmd
from career_planner.commands import resume as resume_cmd
from career_planner.core import brag as brag_core
from career_planner.core import llm as llm_core
from career_planner.core import opportunities as opp_core
from career_planner.core import resume as resume_core
from career_planner.core.workspace import create_workspace

runner = CliRunner(env={"COLUMNS": "200"})


# --- core/resume.py: file I/O ---


def test_resume_path_points_at_workspace_root(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert resume_core.resume_path(ws) == ws / "resume.yml"


def test_load_resume_returns_empty_dict_when_missing(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    assert resume_core.load_resume(ws) == {}


def test_load_resume_reads_template_after_init(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    data = resume_core.load_resume(ws)
    assert "header" in data
    assert "target" in data
    assert "objective" in data
    assert "experience" in data


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    payload = {
        "header": {"name": "Alex", "email": "alex@example.com"},
        "objective": "Backend engineer.",
        "experience": [{"role": "Engineer", "company": "Acme"}],
    }
    resume_core.save_resume(ws, payload)
    assert resume_core.load_resume(ws) == payload


# --- is_empty ---


def test_is_empty_true_for_fresh_template(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    assert resume_core.is_empty(resume_core.load_resume(ws)) is True


def test_is_empty_false_when_name_set() -> None:
    assert resume_core.is_empty({"header": {"name": "Alex"}}) is False


def test_is_empty_false_when_experience_has_role() -> None:
    assert (
        resume_core.is_empty(
            {"experience": [{"role": "Engineer", "company": "Acme"}]}
        )
        is False
    )


def test_is_empty_ignores_blank_experience_entries() -> None:
    assert (
        resume_core.is_empty(
            {"experience": [{"role": "", "company": "", "bullets": []}]}
        )
        is True
    )


# --- render_markdown ---


def test_render_markdown_includes_name_and_contact() -> None:
    resume = {
        "header": {
            "name": "Alex Chen",
            "email": "alex@example.com",
            "location": "Boston, MA",
            "links": [{"label": "GitHub", "url": "https://github.com/alex"}],
        },
    }
    md = resume_core.render_markdown(resume)
    assert md.startswith("# Alex Chen")
    assert "alex@example.com" in md
    assert "Boston, MA" in md
    assert "[GitHub](https://github.com/alex)" in md


def test_render_markdown_includes_objective_section() -> None:
    resume = {"header": {"name": "X"}, "objective": "Backend engineer."}
    md = resume_core.render_markdown(resume)
    assert "## Objective" in md
    assert "Backend engineer." in md


def test_render_markdown_skips_empty_sections() -> None:
    resume = {"header": {"name": "X"}, "objective": "", "experience": []}
    md = resume_core.render_markdown(resume)
    assert "## Objective" not in md
    assert "## Experience" not in md


def test_render_markdown_sorts_experience_by_end_date_desc() -> None:
    resume = {
        "header": {"name": "X"},
        "experience": [
            {"role": "Older", "company": "A", "start": "2020-01", "end": "2021-12"},
            {"role": "Current", "company": "C", "start": "2024-06", "end": "present"},
            {"role": "Recent", "company": "B", "start": "2022-01", "end": "2024-05"},
        ],
    }
    md = resume_core.render_markdown(resume)
    current_idx = md.index("Current — C")
    recent_idx = md.index("Recent — B")
    older_idx = md.index("Older — A")
    assert current_idx < recent_idx < older_idx


def test_render_markdown_renders_bullets_for_experience() -> None:
    resume = {
        "header": {"name": "X"},
        "experience": [
            {
                "role": "Engineer",
                "company": "Acme",
                "bullets": ["Shipped X by doing Z", "Cut latency 30%"],
            }
        ],
    }
    md = resume_core.render_markdown(resume)
    assert "### Engineer — Acme" in md
    assert "- Shipped X by doing Z" in md
    assert "- Cut latency 30%" in md


def test_render_markdown_renders_education_and_extras() -> None:
    resume = {
        "header": {"name": "X"},
        "education": [
            {
                "school": "MIT",
                "degree": "BSc CS",
                "details": ["GPA 3.9"],
            }
        ],
        "extras": [
            {"title": "Projects", "bullets": ["Built a thing"]},
        ],
    }
    md = resume_core.render_markdown(resume)
    assert "## Education" in md
    assert "### BSc CS — MIT" in md
    assert "GPA 3.9" in md
    assert "## Projects" in md
    assert "- Built a thing" in md


# --- render_tailored: AI path ---


def _make_opportunity(workspace: Path, title: str = "Engineer at Acme") -> opp_core.Opportunity:
    path = opp_core.create_opportunity(workspace, title=title)
    return opp_core.load_opportunity(workspace, path.stem)


def _llm_config() -> llm_core.LLMConfig:
    return llm_core.LLMConfig(
        provider="anthropic",
        base_url="https://api.anthropic.com/v1",
        model="claude-sonnet-4-20250514",
        api_key="sk-fake",
    )


def test_render_tailored_returns_llm_markdown(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume = {"header": {"name": "Alex"}, "experience": [{"role": "Engineer"}]}
    opp = _make_opportunity(ws)
    tailored = "# Alex Chen\n\nTailored content here."

    with patch.object(resume_core.llm, "complete", return_value=tailored):
        result = resume_core.render_tailored(resume, opp, _llm_config())

    assert result.startswith("# Alex Chen")
    assert result.endswith("\n")


def test_render_tailored_strips_outer_code_fence(tmp_path: Path) -> None:
    """Models sometimes wrap output in ```markdown ... ```; we strip it."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume = {"header": {"name": "Alex"}}
    opp = _make_opportunity(ws)
    fenced = "```markdown\n# Alex Chen\n\nContent.\n```"

    with patch.object(resume_core.llm, "complete", return_value=fenced):
        result = resume_core.render_tailored(resume, opp, _llm_config())

    assert "```" not in result
    assert result.startswith("# Alex Chen")


def test_render_tailored_includes_target_in_prompt(tmp_path: Path) -> None:
    """The user's `target:` field should be passed to the LLM as planning context."""
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume = {
        "header": {"name": "Alex"},
        "target": "Backend SWE internship, summer 2026",
    }
    opp = _make_opportunity(ws)

    captured: list[str] = []

    def fake_complete(config, *, system, user, **kwargs):
        captured.append(user)
        return "# Alex"

    with patch.object(resume_core.llm, "complete", side_effect=fake_complete):
        resume_core.render_tailored(resume, opp, _llm_config())

    assert "Backend SWE internship, summer 2026" in captured[0]


def test_render_tailored_raises_on_llm_error(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume = {"header": {"name": "Alex"}}
    opp = _make_opportunity(ws)

    with patch.object(
        resume_core.llm, "complete", side_effect=llm_core.LLMAPIError("HTTP 500")
    ):
        with pytest.raises(llm_core.LLMAPIError):
            resume_core.render_tailored(resume, opp, _llm_config())


# --- CLI: career resume edit ---


def _init_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    create_workspace(ws)
    monkeypatch.chdir(ws)
    return ws


def test_cli_resume_edit_opens_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    captured: list[Path] = []

    def fake_open(file_path: Path, editor: str) -> int:
        captured.append(file_path)
        return 0

    with patch.object(common_cmd, "open_in_editor", side_effect=fake_open):
        result = runner.invoke(app, ["resume", "edit"])

    assert result.exit_code == 0, result.output
    assert captured == [ws / "resume.yml"]


def test_cli_resume_edit_handles_missing_editor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    monkeypatch.setenv("EDITOR", "stub-editor")

    with patch.object(
        common_cmd,
        "open_in_editor",
        side_effect=FileNotFoundError("missing"),
    ):
        result = runner.invoke(app, ["resume", "edit"])

    assert result.exit_code == 1
    assert "editor not found" in result.output.lower()


def test_cli_resume_edit_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["resume", "edit"])
    assert result.exit_code == 2


# --- CLI: career resume render ---


def _populate_resume(workspace: Path) -> None:
    resume_core.save_resume(
        workspace,
        {
            "header": {"name": "Alex Chen", "email": "alex@example.com"},
            "objective": "Backend engineer.",
            "experience": [
                {
                    "role": "Engineer",
                    "company": "Acme",
                    "start": "2023-06",
                    "end": "present",
                    "bullets": ["Shipped X by doing Z"],
                }
            ],
        },
    )


def test_cli_resume_render_prints_markdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _populate_resume(ws)
    result = runner.invoke(app, ["resume", "render"])
    assert result.exit_code == 0, result.output
    assert "# Alex Chen" in result.stdout
    assert "## Objective" in result.stdout
    assert "### Engineer — Acme" in result.stdout


def test_cli_resume_render_empty_resume_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _init_workspace(tmp_path, monkeypatch)
    result = runner.invoke(app, ["resume", "render"])
    assert result.exit_code == 1
    assert "empty" in result.output.lower()


def test_cli_resume_render_outside_workspace_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = runner.invoke(app, ["resume", "render"])
    assert result.exit_code == 2


def _setup_llm(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (workspace / "config.yml").write_text(
        "llm:\n"
        "  provider: anthropic\n"
        "  model: claude-sonnet-4-20250514\n"
        "  api_key_env: CAREER_TEST_KEY\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("CAREER_TEST_KEY", "sk-fake")


def test_cli_resume_render_for_opportunity_calls_llm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _populate_resume(ws)
    _setup_llm(ws, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Engineer at Globex", "--no-editor"])

    tailored = "# Alex Chen — Tailored\n\nContent for Globex."
    with patch.object(resume_core.llm, "complete", return_value=tailored):
        result = runner.invoke(
            app, ["resume", "render", "--for", "engineer-at-globex"]
        )

    assert result.exit_code == 0, result.output
    assert "Alex Chen — Tailored" in result.stdout
    assert "Content for Globex" in result.stdout


def test_cli_resume_render_for_missing_opportunity_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _populate_resume(ws)
    _setup_llm(ws, monkeypatch)
    result = runner.invoke(app, ["resume", "render", "--for", "nope"])
    assert result.exit_code == 1
    assert "no opportunity" in result.output.lower()


def test_cli_resume_render_for_missing_llm_config_exits_3(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _populate_resume(ws)
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])
    result = runner.invoke(
        app, ["resume", "render", "--for", "engineer-at-acme"]
    )
    assert result.exit_code == 3
    assert "config.yml" in result.output


def test_cli_resume_render_for_llm_failure_exits_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    _populate_resume(ws)
    _setup_llm(ws, monkeypatch)
    runner.invoke(app, ["opportunity", "add", "Engineer at Acme", "--no-editor"])

    with patch.object(
        resume_core.llm, "complete", side_effect=llm_core.LLMAPIError("HTTP 500")
    ):
        result = runner.invoke(
            app, ["resume", "render", "--for", "engineer-at-acme"]
        )
    assert result.exit_code == 1
    assert "tailoring failed" in result.output.lower()


# --- brag pool gathering (Phase 7) ---


def _write_brag_with_tags(
    workspace: Path, slug: str, *, tags: list[str], body: str = "X"
) -> None:
    """Write a brag entry with explicit frontmatter tags."""
    folder = brag_core.brag_dir(workspace)
    folder.mkdir(parents=True, exist_ok=True)
    date_str = slug[:10]  # assumes YYYY-MM-DD- prefix
    tags_yaml = "[" + ", ".join(tags) + "]"
    contents = f"---\ndate: {date_str}\ntags: {tags_yaml}\n---\n\n{body}\n"
    (folder / f"{slug}.md").write_text(contents, encoding="utf-8")


def test_gather_returns_empty_when_no_experience_tags(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["acme"])
    resume = {"experience": [{"role": "Engineer", "company": "Acme"}]}
    entries, total = resume_cmd._gather_relevant_brag_entries(ws, resume)
    assert entries == ()
    assert total == 0


def test_gather_returns_matching_entries(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-perf", tags=["acme-internship"])
    _write_brag_with_tags(ws, "2026-04-01-db", tags=["acme-internship", "db"])
    resume = {
        "experience": [
            {"role": "Engineer", "company": "Acme", "tags": ["acme-internship"]}
        ]
    }
    entries, total = resume_cmd._gather_relevant_brag_entries(ws, resume)
    assert {e.slug for e in entries} == {"2026-05-01-perf", "2026-04-01-db"}
    assert total == 2


def test_gather_drops_unmatched_entries(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-match", tags=["acme-internship"])
    _write_brag_with_tags(ws, "2026-04-01-nope", tags=["other-project"])
    resume = {
        "experience": [
            {"role": "Engineer", "company": "Acme", "tags": ["acme-internship"]}
        ]
    }
    entries, total = resume_cmd._gather_relevant_brag_entries(ws, resume)
    assert {e.slug for e in entries} == {"2026-05-01-match"}
    assert total == 1


def test_gather_is_case_insensitive(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["Acme-Internship"])
    resume = {
        "experience": [
            {"role": "Engineer", "company": "Acme", "tags": ["acme-internship"]}
        ]
    }
    entries, total = resume_cmd._gather_relevant_brag_entries(ws, resume)
    assert len(entries) == 1
    assert total == 1


def test_gather_caps_at_max_brag_entries(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    # Write MAX + 5 entries, all matching.
    total_written = resume_cmd.MAX_BRAG_ENTRIES + 5
    for i in range(total_written):
        # Vary the date so list_entries' sort order is deterministic.
        day = 1 + i
        _write_brag_with_tags(
            ws, f"2026-05-{day:02d}-x{i}", tags=["acme-internship"]
        )
    resume = {
        "experience": [
            {"role": "Engineer", "company": "Acme", "tags": ["acme-internship"]}
        ]
    }
    entries, total = resume_cmd._gather_relevant_brag_entries(ws, resume)
    assert len(entries) == resume_cmd.MAX_BRAG_ENTRIES
    assert total == total_written
    # Newest entries kept (the highest date numbers).
    kept_slugs = {e.slug for e in entries}
    assert "2026-05-25-x24" in kept_slugs  # newest
    assert "2026-05-01-x0" not in kept_slugs  # oldest


# --- AI tailoring includes brag pool ---


def test_render_tailored_includes_brag_pool_in_prompt(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    _write_brag_with_tags(
        ws,
        "2026-05-01-cut-latency",
        tags=["acme-internship"],
        body="Cut p99 latency from 850ms to 95ms by adding Redis caching.",
    )
    resume = {
        "header": {"name": "Alex"},
        "experience": [
            {"role": "Engineer", "company": "Acme", "tags": ["acme-internship"]}
        ],
    }
    opp = _make_opportunity(ws)
    brag_entries = brag_core.list_entries(ws)

    captured: list[str] = []

    def fake_complete(config, *, system, user, **kwargs):
        captured.append(user)
        return "# Alex"

    with patch.object(resume_core.llm, "complete", side_effect=fake_complete):
        resume_core.render_tailored(
            resume, opp, _llm_config(), brag_entries=brag_entries
        )

    prompt = captured[0]
    assert "## Brag pool" in prompt
    assert "Cut p99 latency from 850ms to 95ms" in prompt
    assert "acme-internship" in prompt


def test_render_tailored_omits_brag_section_when_no_entries(tmp_path: Path) -> None:
    ws = tmp_path / "ws"
    create_workspace(ws)
    resume = {"header": {"name": "Alex"}, "experience": [{"role": "Engineer"}]}
    opp = _make_opportunity(ws)

    captured: list[str] = []

    def fake_complete(config, *, system, user, **kwargs):
        captured.append(user)
        return "# Alex"

    with patch.object(resume_core.llm, "complete", side_effect=fake_complete):
        resume_core.render_tailored(resume, opp, _llm_config())

    prompt = captured[0]
    assert "## Brag pool" not in prompt


# --- CLI end-to-end with brag pool ---


def test_cli_resume_render_for_reports_brag_inclusion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    resume_core.save_resume(
        ws,
        {
            "header": {"name": "Alex"},
            "experience": [
                {
                    "role": "Engineer",
                    "company": "Acme",
                    "tags": ["acme-internship"],
                    "bullets": ["Shipped X"],
                }
            ],
        },
    )
    _write_brag_with_tags(ws, "2026-05-01-x", tags=["acme-internship"], body="Y")
    _setup_llm(ws, monkeypatch)
    runner.invoke(
        app, ["opportunity", "add", "Engineer at Globex", "--no-editor"]
    )

    with patch.object(resume_core.llm, "complete", return_value="# Alex"):
        result = runner.invoke(
            app, ["resume", "render", "--for", "engineer-at-globex"]
        )

    assert result.exit_code == 0, result.output
    assert "Including 1 matching brag entries" in result.output


def test_cli_resume_render_for_reports_capped_brag_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = _init_workspace(tmp_path, monkeypatch)
    resume_core.save_resume(
        ws,
        {
            "header": {"name": "Alex"},
            "experience": [
                {
                    "role": "Engineer",
                    "company": "Acme",
                    "tags": ["acme-internship"],
                    "bullets": ["Shipped X"],
                }
            ],
        },
    )
    # MAX + 3 matching entries → cap fires, "N most recent of M" message.
    for i in range(resume_cmd.MAX_BRAG_ENTRIES + 3):
        day = 1 + i
        _write_brag_with_tags(
            ws, f"2026-05-{day:02d}-x{i}", tags=["acme-internship"]
        )
    _setup_llm(ws, monkeypatch)
    runner.invoke(
        app, ["opportunity", "add", "Engineer at Globex", "--no-editor"]
    )

    with patch.object(resume_core.llm, "complete", return_value="# Alex"):
        result = runner.invoke(
            app, ["resume", "render", "--for", "engineer-at-globex"]
        )

    assert result.exit_code == 0, result.output
    assert f"Including {resume_cmd.MAX_BRAG_ENTRIES} most recent of" in result.output
    assert f"{resume_cmd.MAX_BRAG_ENTRIES + 3} matching brag entries" in result.output
