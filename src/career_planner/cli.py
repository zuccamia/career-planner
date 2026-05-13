"""CLI entry point for career-planner."""

import typer

from career_planner.commands import about as about_cmd
from career_planner.commands import brag as brag_cmd
from career_planner.commands import config as config_cmd
from career_planner.commands import criteria as criteria_cmd
from career_planner.commands import gap as gap_cmd
from career_planner.commands import init as init_cmd
from career_planner.commands import man as man_cmd
from career_planner.commands import opportunity as opportunity_cmd
from career_planner.commands import resume as resume_cmd
from career_planner.commands import skills as skills_cmd
from career_planner.commands import status as status_cmd
from career_planner.i18n import setup as setup_i18n

setup_i18n()

app = typer.Typer(
    name="career",
    help="A local-first, CLI-based personal career planning tool.",
    no_args_is_help=True,
)


def _version_callback(value: bool) -> None:
    if value:
        about_cmd.run()
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        help="Show version and data attribution, then exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """Root callback hosting global options like ``--version``."""

# --- Command groups ---

skills_app = typer.Typer(help="Manage your skills inventory.")
app.add_typer(skills_app, name="skills")

brag_app = typer.Typer(help="Record and review career achievements.")
app.add_typer(brag_app, name="brag")

opportunity_app = typer.Typer(help="Manage tracked career opportunities.")
app.add_typer(opportunity_app, name="opportunity")

criteria_app = typer.Typer(help="Manage your job criteria and dealbreakers.")
app.add_typer(criteria_app, name="criteria")

resume_app = typer.Typer(help="Edit and render your resume.")
app.add_typer(resume_app, name="resume")

memory_app = typer.Typer(help="Manage vector search and semantic memory.")
app.add_typer(memory_app, name="memory")

config_app = typer.Typer(help="Configure tool settings.")
app.add_typer(config_app, name="config")

llm_app = typer.Typer(
    help="Configure the LLM provider for AI-enhanced commands.",
    invoke_without_command=True,
    no_args_is_help=False,
)
config_app.add_typer(llm_app, name="llm")


@llm_app.callback(invoke_without_command=True)
def _llm_default(ctx: typer.Context) -> None:
    """Run the interactive setup when no subcommand is given."""
    if ctx.invoked_subcommand is None:
        config_cmd.setup_llm()


@llm_app.command("test")
def config_llm_test() -> None:
    """Send a minimal prompt to verify the configured LLM is reachable."""
    config_cmd.test_llm()


# --- Top-level commands (stubs) ---


@app.command()
def about() -> None:
    """Show project version and data attribution."""
    about_cmd.run()


@app.command()
def man(
    no_pager: bool = typer.Option(
        False, "--no-pager", help="Print the manual without invoking a pager."
    ),
) -> None:
    """Open the career-planner manual in your pager."""
    man_cmd.run(use_pager=not no_pager)


@app.command()
def init(
    directory: str = typer.Argument(
        ".", help="Directory to initialize the workspace in."
    ),
    language: str = typer.Option(
        "en", "--language", "-l", help="CLI language (en or vi)."
    ),
) -> None:
    """Initialize a new career workspace."""
    init_cmd.run(directory=directory, language=language)


@app.command()
def status() -> None:
    """Display a terminal dashboard of your career planning status and surface stale/missing/orphaned items."""
    status_cmd.run()


@app.command()
def gap(
    opportunity: str = typer.Argument(..., help="Opportunity filename (without extension)."),
    suggest: bool = typer.Option(False, "--suggest", help="Ask AI for gap-closing suggestions."),
) -> None:
    """Run a skill gap analysis against an opportunity."""
    gap_cmd.run(opportunity=opportunity, suggest=suggest)


# --- Command group stubs ---


@criteria_app.command("edit")
def criteria_edit(
    use_editor: bool = typer.Option(
        False,
        "--editor",
        help="Open criteria.yml in your editor instead of the guided prompts.",
    ),
) -> None:
    """Edit criteria via guided prompts (--editor opens raw YAML)."""
    criteria_cmd.edit(use_editor=use_editor)


@criteria_app.command("show")
def criteria_show() -> None:
    """Print a formatted summary of your job criteria."""
    criteria_cmd.show()


@criteria_app.command("check")
def criteria_check(
    opportunity: str = typer.Argument(..., help="Opportunity to check against criteria."),
) -> None:
    """Check an opportunity against your job criteria (AI-driven)."""
    criteria_cmd.check(opportunity=opportunity)


@resume_app.command("edit")
def resume_edit() -> None:
    """Open resume.yml in $EDITOR."""
    resume_cmd.edit()


@resume_app.command("render")
def resume_render(
    opportunity: str | None = typer.Option(
        None,
        "--for",
        help="Opportunity to tailor the resume against (AI-driven).",
    ),
) -> None:
    """Render your resume as markdown (with --for, AI-tailored to an opportunity)."""
    resume_cmd.render(opportunity=opportunity)


@skills_app.command("list")
def skills_list(
    category: str | None = typer.Option(None, "--category", help="Filter by skill category."),
) -> None:
    """Display your skills inventory."""
    skills_cmd.list_skills(category=category)


@skills_app.command("add")
def skills_add(
    skill: str = typer.Argument(..., help="Skill name to add."),
    rating: int | None = typer.Option(None, "--rating", "-r", min=1, max=5, help="Self-rating 1-5."),
    example: str | None = typer.Option(None, "--example", "-e", help="One-line real-world example."),
) -> None:
    """Add a skill to your inventory."""
    skills_cmd.add(skill=skill, rating=rating, example=example)


@skills_app.command("remove")
def skills_remove(
    skill: str = typer.Argument(..., help="Skill name to remove."),
) -> None:
    """Remove a skill from your inventory."""
    skills_cmd.remove(skill=skill)


@skills_app.command("browse")
def skills_browse(
    query: str = typer.Argument(..., help="Keyword to search for in the ESCO skills taxonomy."),
) -> None:
    """Search the bundled ESCO skills taxonomy by keyword."""
    skills_cmd.browse(query=query)


@brag_app.command("add")
def brag_add(
    title: str | None = typer.Argument(
        None, help="Short title for the entry. Prompted if omitted."
    ),
    date: str | None = typer.Option(
        None, "--date", help="Entry date (YYYY-MM-DD). Defaults to today."
    ),
) -> None:
    """Record a new achievement using the XYZ format."""
    brag_cmd.add(title=title, date_str=date)


@brag_app.command("list")
def brag_list(
    last: int = typer.Option(10, "--last", "-n", help="Number of entries to show."),
    tag: str | None = typer.Option(None, "--tag", "-t", help="Filter by tag."),
) -> None:
    """List brag entries (most recent first)."""
    brag_cmd.list_entries(last=last, tag=tag)


@brag_app.command("show")
def brag_show(
    entry: str = typer.Argument(..., help="Entry slug or substring."),
) -> None:
    """Show a specific brag entry."""
    brag_cmd.show(entry=entry)


@opportunity_app.command("add")
def opportunity_add(
    title: str | None = typer.Argument(
        None, help="Title for the opportunity (omit when using --url)."
    ),
    url: str | None = typer.Option(
        None, "--url", help="Import from a job posting URL."
    ),
    no_editor: bool = typer.Option(
        False, "--no-editor", help="Create the file without opening an editor."
    ),
) -> None:
    """Create a new opportunity file."""
    opportunity_cmd.add(title=title, url=url, open_editor=not no_editor)


@opportunity_app.command("parse")
def opportunity_parse(
    url: str = typer.Argument(..., help="Job posting URL to fetch and parse."),
    title: str | None = typer.Option(
        None, "--title", help="Override the title pulled from the page."
    ),
    no_editor: bool = typer.Option(
        False, "--no-editor", help="Create the file without opening an editor."
    ),
) -> None:
    """Create an opportunity from a URL with LLM-assisted field enrichment.

    Shortcut for ``opportunity add --url <url>`` with LLM enrichment always
    on — the page is fetched, structurally extracted, then the configured
    LLM is asked to fill in fields the extractor missed (skills, salary,
    work type, deadline). Requires an LLM provider in ``config.yml``.
    """
    opportunity_cmd.add(
        title=title, url=url, open_editor=not no_editor, parse=True
    )


@opportunity_app.command("list")
def opportunity_list(
    status: str | None = typer.Option(None, "--status", help="Filter by status."),
) -> None:
    """List tracked opportunities."""
    opportunity_cmd.list_opportunities(status=status)


@opportunity_app.command("show")
def opportunity_show(
    opportunity: str = typer.Argument(..., help="Opportunity slug or filename."),
) -> None:
    """Show details of a tracked opportunity."""
    opportunity_cmd.show(opportunity=opportunity)


@memory_app.command("enable")
def memory_enable() -> None:
    """Initialize LanceDB vector search."""
    typer.echo("TODO: Enable memory/vector search")


@memory_app.command("search")
def memory_search(
    query: str = typer.Argument(..., help="Search query."),
) -> None:
    """Semantic search across workspace content."""
    typer.echo(f"TODO: Memory search for '{query}'")


if __name__ == "__main__":
    app()
