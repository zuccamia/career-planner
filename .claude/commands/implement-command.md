Read the man page at docs/man.md and the blueprint at docs/blueprint.md.
Implement the CLI command specified by the user.

Follow the architecture:
- CLI layer: Typer commands in src/career_planner/cli.py (stubs already exist)
- Command logic: src/career_planner/commands/<feature>.py
- Core engine: src/career_planner/core/<module>.py
- Data I/O: always through core/workspace.py, never raw open()
- Taxonomy: always through core/taxonomy.py

Requirements:
- Write tests alongside the implementation in tests/
- All user-facing strings must use _() for i18n
- Type hints on all function signatures
- Use Rich for terminal output (tables, trees, panels)
