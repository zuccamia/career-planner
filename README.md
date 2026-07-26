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

## Data Sources & Attribution

This service uses the ESCO classification of the European Commission.
The bundled ESCO data is a modified and adapted subset of ESCO v1.2.1.

This product includes data from the O*NET database (CC BY 4.0),
sponsored by the U.S. Department of Labor / ETA.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for full details.

## License

MIT
