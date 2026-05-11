# Career Planner

A local-first, open-source, CLI-based personal career planning tool.

> Think "Obsidian for your career" — all your data lives as human-readable
> Markdown and YAML files on your machine. No cloud, no lock-in.

## Features

- **Skills management** — track your skills with ESCO taxonomy codes, self-ratings, and real-world examples
- **Brag document** — record achievements using Google's XYZ format for performance reviews
- **Gap analysis** — compare your skills against job requirements
- **Career paths** — explore common job transitions powered by real data (JobHop dataset)
- **Job criteria** — define what matters to you (function, culture, growth, compensation, location) with dealbreakers
- **AI coaching** — optional LLM-powered career conversations (BYO API key)
- **MCP server** — connect to Notion, Claude Desktop, and other tools via Model Context Protocol
- **International** — ESCO taxonomy (EU) with O\*NET crosswalk (US), CLI available in English and Vietnamese

## Quick start

```bash
pip install career-planner

career init my-career
cd my-career
career profile edit
career skills browse
career status
```

## Documentation

- [Blueprint](docs/blueprint.md) — architecture, data strategy, implementation plan
- [Manual](docs/man.md) — full command reference (also available via `career man`)

## License

MIT
