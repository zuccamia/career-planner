# Career Planner — Project Blueprint

> A local-first, open-source, CLI-based personal career planning tool for tracking job applications and generating tailored resumes, with bring-your-own LLM integration.

---

## Vision

An "Obsidian for your career" — a lightweight tool where all data lives as human-readable flat files on the user's machine. The tool helps you write down your job criteria, track opportunities, log accomplishments (brag entries), maintain a master resume, and generate AI-tailored resumes for specific applications. Skills inventory and gap analysis work offline; opportunity parsing, criteria checking, and resume tailoring use a configured LLM provider.

---

## Design Principles

1. **Local-first**: All data stored as Markdown and YAML on the local filesystem. No cloud dependency.
2. **Human-readable**: Every file is browsable in any text editor. The tool is a lens, not a prison.
3. **AI-augmented, not AI-gated for everything**: Skills inventory, gap analysis, brag logging, and the deterministic resume render all work without an LLM. Opportunity parsing, criteria checking, and resume tailoring are AI-driven by design — the upstream parsing they depend on is only reliable with an LLM, so dual-path "free baseline + AI augment" patterns weren't pulling their weight.
4. **Model-agnostic**: BYO API key — works with Claude, GPT, Ollama, or any OpenAI-compatible endpoint.
5. **International**: Uses ESCO taxonomy as the primary skills framework (EU-native, multilingual), with an O\*NET crosswalk file bundled for U.S. cross-reference.
6. **Stdout-friendly**: AI-generated artifacts (notably `resume render --for`) print to stdout with status/errors on stderr, so they pipe cleanly into files.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                     CLI Interface                        │
│               (Typer + Rich terminal UI)                 │
├──────────────────────────────────────────────────────────┤
│                   Command Layer                          │
│   init │ status │ criteria │ resume │ brag │ skills │    │
│   gap │ opportunity │ config │ about │ man               │
├───────────────────────────┬──────────────────────────────┤
│   Pure Software           │   AI Path (when configured)  │
│                           │  ┌────────────────────────┐  │
│  - workspace I/O          │  │  LLM Adapter           │  │
│  - skills + ESCO loader   │  │  (BYOK; openai-     │  │
│  - gap analysis           │  │   compatible + Anthropic)│ │
│  - brag I/O               │  ├────────────────────────┤  │
│  - resume markdown render │  │  Powers:               │  │
│  - file scaffolding       │  │  - opportunity parse   │  │
│                           │  │  - criteria check      │  │
│                           │  │  - resume render --for │  │
│                           │  │  - gap --suggest       │  │
│                           │  └────────────────────────┘  │
├───────────────────────────┴──────────────────────────────┤
│                     Data Layer                           │
│      Workspace files (Markdown + YAML)                   │
│      Bundled datasets (ESCO subset, ESCO↔O*NET CSV)      │
└──────────────────────────────────────────────────────────┘
```

Deferred for v2: vector search (LanceDB), MCP server, career-path explorer, AI coaching chat. **Vector search stubs remain** in the CLI (`career memory enable/search`) but are non-functional; the others were removed from the command surface entirely.

---

## Workspace Structure

When a user runs `career init`, this directory is created:

```
my-career/
├── config.yml                  # LLM provider, language, editor
├── criteria.yml                # Job criteria: function, culture, growth, compensation, location
├── resume.yml                  # Master resume content (header, target, objective, experience, …)
│
├── skills/
│   └── inventory.yml           # Self-rated skills mapped to ESCO codes, with examples
│
├── brag/                       # Achievement entries (XYZ format)
│   └── 2026-05-09-cut-latency.md
│
├── resumes/                    # Rendered resume markdown files
│   └── senior-engineer-at-acme.md
│
├── opportunities/              # Jobs being evaluated
│   └── senior-engineer-at-acme.md
│
├── assessments/                # Reserved for future decision frameworks
│
├── data/                       # Local data stores
│   ├── coaching/               # AI coaching config (editable; used as future context)
│   │   ├── system-prompt.md
│   │   └── policies.md
│   ├── esco-skills.yml         # Bundled ESCO subset
│   ├── esco-occupations.yml
│   ├── esco-occupation-skills.yml
│   ├── esco-skill-hierarchy.yml
│   ├── crosswalk.csv           # ESCO ↔ O*NET mapping
│   └── cache/                  # Cached API responses
│
└── locale/                     # i18n translation files
    └── vi/
        └── LC_MESSAGES/
            └── career.mo
```

All workspace files use YAML for structured data and Markdown for human-readable content (with YAML frontmatter on the markdown files).

---

## Feature Set

The v1 CLI surface (see `docs/man.md` for the full reference):

| Command | Description |
|---|---|
| `career init` | Create workspace with starter templates, bundled ESCO data, and coaching config |
| `career man` | Open the user manual in a pager; `--no-pager` prints to stdout |
| `career status` | Terminal dashboard: active opportunities, brag freshness, skills coverage, criteria fit, warnings |
| `career config llm` | Interactive LLM provider wizard (rewrites the `llm:` block in `config.yml`) |
| `career config llm test` | Connection check against the configured provider |
| `career criteria edit/show` | Edit and view job criteria across 5 dimensions |
| `career criteria check <opp>` *(AI)* | LLM-judged fit per dimension with quoted dealbreaker context |
| `career resume edit` | Open `resume.yml` in `$EDITOR` |
| `career resume render` | Deterministic markdown render of the master resume to stdout |
| `career resume render --for <opp>` *(AI)* | LLM-tailored markdown for a specific opportunity |
| `career brag add [title]` | Create an XYZ-format entry from template, open in editor |
| `career brag list/show` | List entries (with `--tag` / `--last` filters) or show one |
| `career opportunity add <title> \| --url <url>` | Create an opportunity file; URL mode uses deterministic JSON-LD/OG extraction |
| `career opportunity parse <url>` *(AI)* | Full LLM extraction of a job posting |
| `career opportunity list/show` | List and inspect tracked opportunities |
| `career skills add/list/remove` | Manage the skills inventory (ESCO-coded) |
| `career skills browse <query>` | Keyword-search the bundled ESCO taxonomy |
| `career gap <opp> [--suggest]` | Skills inventory vs. opportunity requirements; `--suggest` is the AI advice layer |

`brag` entries link to `resume.yml` experience entries via shared `tags`. A planned (small) enhancement will have `resume render --for` pull tag-matching brag bullets into the LLM's prompt as an additional bullet pool.

### Removed from the original blueprint

These were in the original v1 plan but were cut as the tool narrowed to "apply and track jobs":

- **Profile** (`profile.yml` + `career profile edit/show`) — identity, target role, and history collapsed into `resume.yml`; forward-looking fields like `target_role` survive as `resume.yml`'s `target:` (planning-only, never rendered).
- **Career paths** (`career path`, `career path explore`) — the JobHop transition matrix was deleted; bundled data is no longer in the repo.
- **AI chat** (`career chat`) — open-ended coaching loop; deferred until enough usage data exists to make it useful.
- **Data download** (`career data download/update`) — full ESCO/O\*NET downloads; the bundled subset is sufficient for v1.
- **MCP server** (`career mcp start`) — Notion integration story; deferred.
- **Timeline** (`career timeline`) — ASCII career history view; cut as low-value relative to status.
- **Vector search** (`career memory enable/search`) — LanceDB-backed semantic search; stubs remain in the CLI but neither command does anything yet.
- **Brag reflect / brag summary** — AI pattern analysis and plain-text summary commands; deferred.
- **Resume add / resume list / resume review** — PDF-based resume tracking with metadata sidecars; replaced by the resume.yml + `resume render` pipeline.
- **Skills browse modes** — the `--for` and `--vs` occupation views and the no-arg tree view; `browse` is now a positional keyword search.

The deterministic criteria check engine (phrase scanning, salary floor checks, work-type compatibility logic) was also removed — `criteria check` is now LLM-only.

---

## Data Strategy

### Bundled: ESCO (European Skills, Competences, Qualifications and Occupations)

- **What**: EU multilingual classification covering skills, competences, and occupations.
- **Why**: International reach, free, maintained by the European Commission, detailed skills pillar.
- **What ships**: A curated YAML export of ~1,000 skills focused on knowledge-worker and tech-worker roles, plus occupation-to-skills mappings (~2–5 MB total). Generated by `scripts/prepare_esco.py`.
- **Source**: https://esco.ec.europa.eu — free, open.

### Bundled: ESCO ↔ O\*NET Crosswalk

- **What**: Mapping table between ESCO and O\*NET occupation codes.
- **Why**: Cross-reference for users thinking in either taxonomy.
- **What ships**: A filtered CSV (~50 KB) covering the curated occupation subset. Generated by `scripts/prepare_onet_crosswalk.py`.
- **Source**: https://esco.ec.europa.eu/en/use-esco/other-crosswalks and https://www.onetcenter.org/crosswalks.html — free, CC.

### Data Preparation Pipeline

The bundled YAML/CSV are pre-baked and committed to the repo. Users never run preparation scripts; the maintainer regenerates them when source datasets update.

```
scripts/
├── prepare_esco.py               # ESCO CSVs → curated YAML
├── prepare_onet_crosswalk.py     # ESCO↔O*NET crosswalk → bundled CSV
└── prepare_all.py                # Run all preparation steps
```

Note: `scripts/prepare_jobhop_matrix.py` (career-path transition matrix) was removed when the path feature was cut.

**Bundled data files** (`src/career_planner/data/`):

| File | Purpose | Approx. size |
|---|---|---|
| `esco-skills.yml` | ~1,000 curated skills | 1–2 MB |
| `esco-occupations.yml` | ISCO Major Groups 1–3 occupations | ~200 KB |
| `esco-occupation-skills.yml` | Occupation → skills mapping | ~500 KB |
| `esco-skill-hierarchy.yml` | Skill tree for hierarchical browse (currently unused by the v1 surface) | ~100 KB |
| `crosswalk.csv` | ESCO ↔ O\*NET | ~50 KB |
| `coaching/system-prompt.md` | AI coaching prompt template (reserved for future chat) | small |
| `coaching/policies.md` | AI coaching behavioral policies | small |

Total bundled data: ~3–4 MB.

---

## AI Path

All LLM calls go through `src/career_planner/core/llm.py`, a single adapter that speaks both Anthropic's native API shape and the OpenAI Chat Completions shape (which covers OpenAI, OpenRouter, Together, Fireworks, MiniMax, local + hosted Ollama, and most gateways). Provider selection is via `config.yml`'s `llm:` block; API keys are read from named environment variables (never stored on disk).

### AI-driven features

| Feature | Prompt shape | Output |
|---|---|---|
| `opportunity parse` | Stripped page text | JSON: full opportunity frontmatter fields |
| `criteria check` | Criteria YAML + opportunity frontmatter + body | JSON: per-dimension status, violations, positives, negatives, summary |
| `resume render --for` | Resume YAML + opportunity + user's `target` | Markdown (tailored resume) |
| `gap --suggest` | Skills inventory + opportunity required_skills + gap analysis | Markdown bullet list (courses, projects, certs) |

All four commands exit **3** if no LLM provider is configured. Network/parse failures generally exit **1** with a friendly error; `opportunity parse` is the exception — it falls back to the deterministic JSON-LD/OG extractor so the user still gets a populated file.

---

## Tech Stack

| Dependency | Purpose |
|---|---|
| Python 3.10+ | Runtime |
| Typer | CLI framework |
| Rich | Terminal formatting, tables, markdown rendering |
| PyYAML | Config and data file parsing |
| httpx | HTTP client for LLM API calls and URL fetching |

Optional extras are available for future enhancements: `[memory]` (LanceDB for vector search) and `[mcp]` (FastMCP for integrations) are listed in `pyproject.toml` but not required for v1. The core install includes all essential v1 features. AI features use the same `httpx` dependency already in core.

---

## Config File (`config.yml`)

```yaml
# CLI interface language ("en" or "vi")
language: en

# LLM Provider — required for opportunity parse, criteria check,
# resume render --for, and gap --suggest. Other commands work without it.
#
# Two provider shapes are supported: "anthropic" and "openai-compatible".
# The openai-compatible shape covers OpenAI, Ollama (local + cloud),
# Together, Fireworks, OpenRouter, MiniMax, and most hosted gateways.
llm:
  provider: anthropic
  base_url: https://api.anthropic.com/v1
  api_key_env: ANTHROPIC_API_KEY      # env var NAME — keys never stored in file
  model: claude-sonnet-4-20250514

# Editor — used by `criteria edit --editor`, `resume edit`, `brag add`,
# `opportunity add`. Defaults to $EDITOR, fallback to vim.
editor: $EDITOR
```

Configure interactively via `career config llm`, which walks a preset list (Anthropic, Ollama Cloud, Local Ollama, OpenAI, OpenRouter, Custom) and rewrites the `llm:` block while preserving comments and other sections.

---

## Getting Started

```bash
# Install
pip install career-planner

# Initialize workspace
cd ~/Documents
career init my-career
cd my-career

# Configure your LLM provider
career config llm
export ANTHROPIC_API_KEY=sk-...     # or whatever your provider uses
career config llm test

# Fill in your job criteria and master resume
career criteria edit
career resume edit

# Add your skills with real-world examples
career skills browse "client communication"  # find the ESCO term
career skills add "Python programming" --rating 4 \
    --example "Built data pipeline processing 2M records/day"

# Track an opportunity
career opportunity parse https://example.com/jobs/12345
# (or manually)
career opportunity add "Senior Engineer at Acme Corp"

# Check fit and gaps
career criteria check senior-engineer-at-acme-corp
career gap senior-engineer-at-acme-corp

# Generate a tailored resume
career resume render --for senior-engineer-at-acme-corp \
    > resumes/senior-engineer-at-acme-corp.md

# Record what you ship
career brag add "Cut p99 latency by 30%"

# Daily dashboard
career status

# Vietnamese interface
career init my-career --language vi
```

---

## Landscape & Related Projects

No existing tool combines local-first CLI, skill taxonomies, gap analysis, and AI-tailored resume generation for individuals. The adjacent space includes:

- **career-open-source** (github.com/w0rd-driven/career-open-source) — Obsidian-based Markdown templates for career tracking. Right philosophy, but a template repo with no tooling or data.
- **career-ops** (github.com/career-ops/career-ops) — AI-powered job search automation (resume generation, job board scanning). Focused on active job hunting; requires Claude Code; not local-first.
- **esco-skill-extractor** (github.com/KonstantinosPetrakis/esco-skill-extractor) — Python library that extracts ESCO skills from job postings using embeddings. Not an end-user tool, but a potential future integration for auto-populating opportunity files.
- **Nesta Skills Extractor** (github.com/nestauk/ojd_daps_skills) — Similar NLP library mapping job ad text to ESCO/Lightcast taxonomies.
- **Lightcast Open Skills** (lightcast.io/open-skills) — 32K+ skill taxonomy updated biweekly from job postings. A potential third taxonomy source alongside ESCO/O\*NET.

---

## Decisions Log

1. **AI-first for opportunity/criteria/resume features.** Upstream parsing of opportunity content needs an LLM to reliably populate `required_skills`; deterministic checks layered on top were working with unreliable data. The original "free baseline + opt-in AI augment" pattern (e.g. `criteria check --reason`, `resume tailor` vs. `resume render`) collapsed into AI-always commands. Exit code 3 when no provider is configured. The one documented exception is `gap --suggest`: gap's deterministic match against the user-authored skills inventory still has standalone value.
2. **`resume.yml` subsumes `profile.yml`.** The identity (`name`), work history, and forward-looking `target_role` content from the original profile collapsed into resume.yml. A new `target:` field at the top of resume.yml holds the planning anchor and is passed to the LLM as context but never rendered onto the resume itself.
3. **Bullets live inline in resume.yml.** The original design pulled bullets exclusively from brag entries. v1 puts them inline in resume.yml so the tool is useful on day one before any brag entries exist. Each experience entry has an optional `tags:` field that links to brag entries with matching tags — a planned enhancement will let `resume render --for` augment the LLM's bullet pool with matching brag content.
4. **Resume render writes to stdout.** Both the deterministic and AI-tailored renders print markdown to stdout, with status/errors on stderr. Users redirect (`> resumes/<slug>.md`) when they want to save. Simpler than auto-writing to `resumes/`, and the `resumes/` directory in the workspace becomes a place users curate intentionally.
5. **Optional extras for future features.** Original plan had `[ai]`, `[memory]`, `[mcp]` extras. The `[ai]` placeholder is removed; AI features use `httpx` from core. The `[memory]` (LanceDB) and `[mcp]` (FastMCP) extras remain in `pyproject.toml` for future v2 integrations.
6. **Project name**: `career-planner`. The existing GitHub repo `sanatladkat/career-planner` is a Streamlit web app — architecturally very different. The name is generic enough to share.

---

## References & Data Sources

| Resource | URL | License |
|---|---|---|
| ESCO Classification | https://esco.ec.europa.eu | Free, European Commission |
| ESCO ↔ O\*NET Crosswalk | https://esco.ec.europa.eu/en/use-esco/other-crosswalks | Free |
| O\*NET Database | https://www.onetcenter.org/database.html | Creative Commons 4.0 |
| O\*NET Crosswalk Files | https://www.onetcenter.org/crosswalks.html | Creative Commons 4.0 |
| O\*NET Web Services API | https://services.onetcenter.org/reference/ | Free (registration required) |
| ESCO ↔ O\*NET Technical Report | https://esco.ec.europa.eu/en/about-esco/publications/publication/crosswalk-between-esco-and-onet-technical-report | Free |
