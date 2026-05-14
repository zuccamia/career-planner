# Career Planner

A local-first, open-source CLI for personal career planning.

> Think “Obsidian for your career” — all your data lives as human-readable
> Markdown and YAML files on your machine. No cloud, no lock-in.

## Overview

Career Planner helps you manage skills, track opportunities, evaluate fit, and generate resumes from a single local workspace.

Key capabilities:

- Skills tracking with ESCO taxonomy codes, self-ratings, and real-world examples
- Brag entries for achievements using Google’s XYZ format
- Gap analysis against job requirements
- Job criteria and dealbreaker management
- Opportunity tracking and AI-assisted parsing
- Resume creation with optional LLM tailoring
- English and Vietnamese CLI support
- ESCO + O*NET crosswalk for international compatibility

## Quick Start

Install the package and create a workspace:

```bash
pip install career-planner
career init my-career
cd my-career
career criteria edit
career skills browse
career status
```

For a full walkthrough, see the [Manual](docs/man.md) or run:

```bash
career man
```

## Installation

### Core install

```bash
pip install career-planner
```

All v1 features are available with the core install.

### Optional extras

- `pip install career-planner[memory]` — LanceDB semantic search (planned for v2)
- `pip install career-planner[mcp]` — FastMCP integrations (planned for v2)
- `pip install career-planner[dev]` — development dependencies (pytest, ruff, etc.)
- `pip install career-planner[all]` — all optional dependencies

## Features

- **Skills management** — track skills, ratings, taxonomy codes, and performance examples
- **Brag document** — capture achievements with structured, review-ready statements
- **Gap analysis** — compare your strengths against job requirements
- **Job criteria** — define priorities, dealbreakers, and personal fit factors
- **Opportunity tracking** — collect jobs, parse postings, and compare them to your criteria
- **Resume generation** — render deterministic resumes or generate LLM-tailored variants
- **AI support** — optional Bring Your Own API Key workflow for parsing, scoring, and resume tailoring
- **International support** — ESCO taxonomy, O*NET crosswalk, English/Vietnamese CLI

## Usage Examples

Initialize a workspace and configure the LLM:

```bash
career init my-career
cd my-career
career config llm
export ANTHROPIC_API_KEY=sk-ant-...
career config llm test
```

Edit your criteria and master resume:

```bash
career criteria edit
career resume edit
```

Add a skill with a working example:

```bash
career skills browse "client communication"
career skills add "Python programming" --rating 4 \
  --example "Built data pipeline processing 2M records/day"
career skills list
```

Track an opportunity manually or parse from a URL:

```bash
career opportunity add "Senior Engineer at Acme Corp"
career opportunity parse https://example.com/jobs/12345
```

Evaluate fit and discover gaps:

```bash
career criteria check senior-engineer-at-acme-corp
career gap senior-engineer-at-acme-corp
career gap senior-engineer-at-acme-corp --suggest
```

Generate a tailored resume:

```bash
career resume render --for senior-engineer-at-acme-corp \
  > resumes/senior-engineer-at-acme-corp.md
```

Record an achievement:

```bash
career brag add "Cut p99 latency by 30%"
career brag list --last 5
```

Open your daily dashboard:

```bash
career status
```

Use the Vietnamese interface:

```bash
career init my-career --language vi
```

Or set it in `config.yml`:

```yaml
language: vi
```

## Documentation

- [Blueprint](docs/blueprint.md) — architecture, data strategy, implementation plan
- [Manual](docs/man.md) — full command reference and workflow guide

## Data Sources & Attribution

- Uses the ESCO classification from the European Commission
- Bundled ESCO data is a modified and adapted subset of ESCO v1.2.1
- Includes O*NET data under CC BY 4.0, sponsored by the U.S. Department of Labor / ETA

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for full attribution details.

## Contributing

Contributions are welcome. Please open issues or pull requests on GitHub.

## License

MIT
