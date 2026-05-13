# Career Planner — Project Blueprint

> A local-first, open-source, CLI-based personal career planning tool with optional AI coaching and MCP integration.

---

## Vision

An "Obsidian for your career" — a lightweight, privacy-first tool where all data lives as human-readable flat files on the user's machine. The tool provides structured career planning features out of the box (no AI required), with optional LLM integration for deeper coaching and MCP support for connecting to external services like Notion.

---

## Design Principles

1. **Local-first**: All data stored as Markdown and YAML on the local filesystem. No cloud dependency.
2. **Human-readable**: Every file is browsable in any text editor. The tool is a lens, not a prison.
3. **CS-freshman friendly**: `pip install career-planner && career init` should be all it takes.
4. **AI-optional**: Core features work without any LLM. AI enhances but never gates functionality.
5. **Model-agnostic**: BYO API key — works with Claude, GPT, Ollama, or any OpenAI-compatible endpoint.
6. **Pluggable**: MCP server architecture lets the tool connect to Notion, and other services.
7. **International**: Uses ESCO taxonomy as the primary skills framework (EU-native, multilingual), with O\*NET crosswalk for U.S. coverage.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     CLI Interface                       │
│               (Typer + Rich terminal UI)                │
├─────────────────────────────────────────────────────────┤
│                   Command Layer                         │
│   init │ man │ brag │ skills │ gap │ status │ path │... │
├──────────────────┬──────────────────────────────────────┤
│  Pure Software   │         AI Layer (optional)          │
│    Engine        │  ┌─────────────────────────────────┐ │
│                  │  │   LLM Adapter (BYO API key)     │ │
│  - Skills mgmt   │  │   Claude │ GPT │ Ollama │ ...   │ │
│  - Gap analysis  │  ├─────────────────────────────────┤ │
│  - Comparisons   │  │   Vector Store (optional)       │ │
│  - Path lookup   │  │   LanceDB for semantic search   │ │
│  - Validation    │  └─────────────────────────────────┘ │
├──────────────────┴──────────────────────────────────────┤
│                  MCP Server (FastMCP)                   │
│          Exposes tools to Notion, Claude, etc.          │
├─────────────────────────────────────────────────────────┤
│                  Data Layer                              │
│        Flat files (Markdown + YAML + JSON)              │
│        Bundled datasets (ESCO, O*NET, JobHop)           │
└─────────────────────────────────────────────────────────┘
```

---

## Workspace Structure

When a user runs `career init`, the following directory is created:

```
my-career/
├── config.yml                  # LLM provider, MCP settings, preferences
├── profile.yml                 # Identity: current role, target role, values, constraints
├── criteria.yml                # Job criteria: function, culture, growth, compensation, location
│
├── skills/
│   └── inventory.yml           # Self-rated skills mapped to ESCO codes, with examples
│
├── brag/                       # Achievement entries (XYZ format, not daily)
│   └── 2026-05-09-pipeline.md
│
├── resumes/                    # Versioned resume files (PDFs stored as-is)
│   ├── resume-v1.pdf           # Original PDF, with YAML sidecar for metadata
│   └── resume-v1.yml           # Sidecar: date, target role, version notes
│
├── opportunities/              # Jobs or career paths being evaluated
│   └── senior-eng-acme.md
│
├── assessments/                # Decision matrices, SWOT, framework outputs
│   └── pivot-decision.md
│
├── conversations/              # Saved AI coaching sessions (if AI enabled)
│   └── 2026-05-09-pivot-chat.md
│
├── data/                       # Local data stores
│   ├── coaching/               # AI coaching config (editable)
│   │   ├── system-prompt.md    # System prompt template with {{variables}}
│   │   └── policies.md        # Behavioral policies (truthfulness, boundaries, etc.)
│   ├── .vectordb/              # LanceDB files (created on opt-in)
│   └── cache/                  # Cached dataset lookups
│
└── locale/                     # i18n translation files
    └── vi/
        └── LC_MESSAGES/
            └── career.mo       # Vietnamese translations
```

All files use YAML frontmatter for metadata, with Markdown for human-readable content.

---

## Data Strategy

### Primary: ESCO (European Skills, Competences, Qualifications and Occupations)

- **What**: EU multilingual classification covering skills, competences, and occupations in 25+ languages.
- **Why**: International reach, free, maintained by the European Commission, detailed skills pillar.
- **How bundled**: A curated YAML export of ~1,000 skills focused on knowledge-worker and tech-worker roles, plus occupation-to-skills mappings (~2–5 MB). Full 13K taxonomy available via `career data download esco-full`.
- **Source**: https://esco.ec.europa.eu — free, open, API available.

### Secondary: O\*NET (U.S. Occupational Information Network)

- **What**: U.S. Department of Labor database covering 923+ occupations with skills, knowledge, abilities, and work activities.
- **Why**: Deep U.S. labor market coverage, complementary to ESCO.
- **How bundled**: A curated subset (skills taxonomy + occupation mappings) ships as YAML. Full 40-file database available as optional download.
- **Source**: https://www.onetcenter.org/database.html — Creative Commons license, free download, updated quarterly.

### ESCO ↔ O\*NET Crosswalk

The official crosswalk between the two taxonomies is available through multiple channels:

- **Static CSV download** (recommended for bundling): The complete mapping table is available as a free CSV download from both the ESCO portal (https://esco.ec.europa.eu/en/use-esco/other-crosswalks) and the O\*NET Resource Center (https://www.onetcenter.org/crosswalks.html). Two versions exist: one with exact/narrow/broad/close matches, and one enriched with additional "related" matches (lower quality, not fully validated). All ESCO occupations are mapped to at least one O\*NET occupation. This file should be bundled in the repo for offline use.
- **O\*NET Web Services API**: O\*NET provides a live ESCO crosswalk search endpoint (https://services.onetcenter.org/reference/online/crosswalk/esco) that returns paginated results (20 per page). Useful for on-demand lookups when the user wants the freshest mapping.
- **ESCO API**: ESCO offers both a hosted web-based API and a downloadable local API that can be installed on the user's machine for offline access with better performance. The local API is ideal for this tool's local-first philosophy.

**Recommended approach**: Bundle the static CSV crosswalk in the repo (small file, works offline). Use the O\*NET or ESCO APIs as optional live-lookup fallbacks when fresher data is needed.

### Career Transitions: JobHop

- **What**: 1.67M+ work experiences from 361K+ anonymized resumes (Flanders, Belgium), mapped to ESCO occupation codes. 475 MB total, licensed CC BY 4.0.
- **Why**: Real-world transition probabilities between occupations. Powers the `career path` feature.
- **Access methods** (JobHop has no dedicated API, but HuggingFace provides access):
  1. **HuggingFace Datasets Server REST API** (for on-demand queries): Query slices of up to 100 rows at a time via plain HTTP — e.g., `GET https://datasets-server.huggingface.co/rows?dataset=aida-ugent/JobHop&config=default&split=train&offset=0&length=100`. Requires only `httpx` (already in the core stack). Supports search across text columns.
  2. **Direct Parquet download**: The dataset is also available in Parquet format via direct URLs, queryable with DuckDB or Pandas. Reserved for a future iteration if full local access is needed.
- **How bundled** (v1 — two tiers):
  - **Offline mode** (default): A small pre-computed transition probability matrix (~1–2 MB) derived from JobHop ships as a bundled YAML/JSON file. Covers the most common occupation-to-occupation transitions. Works instantly, no internet needed.
  - **Online mode** (richer): `career path --online` queries the HuggingFace Datasets Server REST API on demand for deeper or less common transition lookups. Requires internet but no extra dependencies beyond `httpx`.
- **Source**: https://huggingface.co/datasets/aida-ugent/JobHop — CC BY 4.0, from Ghent University / VDAB.

### Supplementary: LinkedIn Career Explorer

- **What**: Aggregated 5-year career transition data with skill overlap scores.
- **Why**: Alternative/complementary transition data source, U.S.-focused.
- **Source**: https://linkedin.github.io/career-explorer/ — check license for data extraction feasibility.

### Data Preparation Pipeline

None of the above datasets are available as pip-installable packages. ESCO ships as 19 CSV files from the ESCO portal, O\*NET as 40+ flat text files, and JobHop as a 475 MB Parquet dataset on HuggingFace. All require downloading, processing, filtering, and reshaping before they're usable by the tool.

**Approach: pre-bake and commit to repo (Option A).** All curated data files are generated by maintainer-only scripts in `scripts/`, committed to the repo, and distributed with the pip package. Users never interact with raw source data. This ensures the tool works offline from first `pip install` with zero internet dependency at runtime (except for `--online` and `career data download` features).

**`scripts/` directory:**

```
scripts/
├── prepare_esco.py          # Download ESCO CSVs → curated YAML
├── prepare_onet_crosswalk.py # Download O*NET crosswalk CSV → bundled CSV
├── prepare_jobhop_matrix.py  # Query JobHop via HuggingFace API → transition matrix YAML
├── prepare_all.py            # Run all preparation scripts in sequence
└── README.md                 # Instructions for maintainers on re-running
```

**`scripts/prepare_esco.py`** performs:

1. Download ESCO v1.2.1 English CSV package from the ESCO portal (skills, occupations, ISCO groups, occupation-skill relationships, skill hierarchy).
2. Parse the 19 CSV files into a unified in-memory model.
3. Filter skills to ~1,000 focused on tech/knowledge-worker roles. Filtering strategy:
   - Start with ISCO Major Groups 1 (Managers), 2 (Professionals), 3 (Technicians), which cover most tech/knowledge workers.
   - From those groups, collect all ESCO occupations and their linked skills.
   - Rank skills by how many of these occupations reference them.
   - Take the top ~1,000 skills by frequency, ensuring coverage of: digital/ICT skills, communication, leadership, project management, data/analytics, engineering, and transversal skills.
   - Include the full skill hierarchy (parents) so browse-by-tree works.
4. Output curated files to `src/career_planner/data/`:
   - `esco-skills.yml` — ~1,000 skills with URI, preferred label, description, skill type, hierarchy path.
   - `esco-occupations.yml` — Occupations from ISCO groups 1-3 with URI, preferred label, ISCO code, description.
   - `esco-occupation-skills.yml` — Mapping of occupation URIs to skill URIs (the relationships).
   - `esco-skill-hierarchy.yml` — Parent-child relationships for tree browsing.

**`scripts/prepare_onet_crosswalk.py`** performs:

1. Download the ESCO ↔ O\*NET crosswalk CSV from the O\*NET Resource Center.
2. Filter to only occupations present in our curated ESCO subset.
3. Copy the filtered CSV to `src/career_planner/data/crosswalk.csv`.

**`scripts/prepare_jobhop_matrix.py`** performs:

1. Query the HuggingFace Datasets Server REST API to fetch JobHop occupation transition data (paginated, 100 rows per request).
2. Compute transition probabilities: for each ESCO occupation code, count how many people transitioned to each other occupation code.
3. Filter to occupations present in our curated ESCO subset.
4. Output `src/career_planner/data/transitions.yml` — a matrix of `{from_occupation: [{to_occupation, probability, count}, ...]}`, including only transitions with ≥5 occurrences. Includes a `version_date` field stamped with the JobHop dataset's `updated_at` metadata.

**Bundled data files** (committed to repo, shipped with pip package):

```
src/career_planner/data/
├── esco-skills.yml              # ~1,000 curated skills (~1–2 MB)
├── esco-occupations.yml         # ~200–400 occupations (~200 KB)
├── esco-occupation-skills.yml   # Occupation → skills mapping (~500 KB)
├── esco-skill-hierarchy.yml     # Skill tree for browse (~100 KB)
├── crosswalk.csv                # ESCO ↔ O*NET mapping (~50 KB)
├── transitions.yml              # JobHop transition matrix (~500 KB–1 MB)
└── coaching/
    ├── system-prompt.md         # Default AI coaching prompt
    └── policies.md              # Default AI coaching policies
```

Total estimated bundle size: ~3–5 MB. Acceptable for a pip package.

**When to re-run scripts:**

- ESCO releases a new version (major ~every 2 years, minor ~annually) → re-run `prepare_esco.py`.
- O\*NET updates crosswalk files (quarterly) → re-run `prepare_onet_crosswalk.py`.
- JobHop publishes new data (irregular) → re-run `prepare_jobhop_matrix.py`.
- `prepare_all.py` re-runs everything and commits updated files.

**What `career data download` does for end users:**

This command does NOT run the preparation scripts. Instead, it downloads the full pre-processed datasets that are too large to bundle:

- `career data download esco-full` — downloads the complete ESCO taxonomy (all ~13,500 skills, all occupations, all languages) as processed YAML files from a hosted release artifact (e.g., GitHub Releases). The preparation of these full files is also done by maintainer scripts.
- `career data download onet-full` — same pattern for the full O\*NET database.

**What `career data update` does:**

Checks the HuggingFace API for a newer version of JobHop, and if found, re-runs the transition matrix computation via the REST API (same logic as `prepare_jobhop_matrix.py` but running on the user's machine). This is the one case where a user runs data processing locally.

---

## Feature Set

### Tier 1 — Scaffolding & Structure (MVP, no AI)

| Command | Description |
|---|---|
| `career init` | Create workspace with starter templates, bundled data, and coaching config |
| `career man` | Open the full user manual (docs/man.md) in a pager; `--no-pager` prints to stdout |
| `career criteria edit` | Open `criteria.yml` to set job preferences and dealbreakers (function, culture, growth, compensation, location) |
| `career criteria show` | Print formatted summary of current job criteria, flag incomplete dimensions |
| `career criteria check <opportunity>` | Check an opportunity against criteria; flag dealbreaker violations, score alignment |
| `career brag add [--date]` | Record an achievement using XYZ format template; not daily — use per project/milestone |
| `career brag list [--last N] [--tag TAG]` | List brag entries by date, filterable by tag |
| `career brag summary [--period quarter\|half\|year]` | Generate plain-text accomplishment summary for a time period |
| `career resume add <file>` | Import a resume PDF into `resumes/` as-is with a YAML sidecar (date, target role, version notes) |
| `career opportunity add <title>` | Create structured opportunity file (role, company, pros/cons, skills, salary, deadline) |
| `career opportunity add --url <url>` | Create opportunity from a job posting URL with best-effort HTML extraction (use `career opportunity parse` for AI-assisted enrichment) |
| `career opportunity list [--status]` | List tracked opportunities, optionally filtered by status |
| `career opportunity show <opportunity>` | Print full details of a specific opportunity |
| `career skills list` | Show current skills inventory with ratings and one-line examples |
| `career skills add <skill>` | Add a skill with self-rating and real-world example; fuzzy-match against ESCO taxonomy |
| `career skills browse` | Interactive terminal browser for ESCO skill categories (see browse modes below) |
| `career skills browse --search <keyword>` | Keyword search across ESCO skills (e.g., `--search "negotiation"`) |
| `career skills browse --for <occupation>` | Show skills associated with a specific ESCO occupation |
| `career gap <opportunity>` | Compare your skills against an opportunity's requirements; show matches and gaps |
| `career status` | Terminal dashboard: active opportunities, days since last brag, skill coverage, deadlines |

**`career skills browse` — detail**

The browse command serves multiple user scenarios with three entry points:

1. **Hierarchy navigation** (`career skills browse`): Full top-down tree of the ESCO skills taxonomy using Rich's tree/table widgets. Navigate with arrow keys, expand/collapse categories. If the user has a target role set in `profile.yml`, the tree highlights skills relevant to that role. Press `a` on any skill to add it to the inventory with a rating and example prompt.

2. **Keyword search** (`career skills browse --search "client communication"`): For users who know what they do but not the standardized term. Fuzzy-matches the query against ESCO skill labels and descriptions, returns a ranked list. Useful for translating informal language ("talking to clients") into taxonomy terms ("manage client relationships").

3. **Occupation filter** (`career skills browse --for "product manager"`): Shows the skill profile for a specific ESCO occupation — which skills it requires, grouped by category. Useful for exploring unfamiliar fields, identifying bridge skills between two roles, or building a gap-analysis target before a formal `career gap` run. Can also accept two occupations (`--for "software developer" --vs "product manager"`) to show overlapping and unique skills side by side.

### Tier 2 — Career Path Preview (lite, no AI)

| Command | Description |
|---|---|
| `career path [--from <role>] [--to <role>]` | Show common transition paths between ESCO occupations using bundled JobHop data; add `--online` for deeper lookups via API |
| `career path explore` | Given current role from profile, show most common next-step occupations |
| `career compare <opp1> <opp2>` | Side-by-side weighted comparison of two opportunities |
| `career data download <dataset>` | Download optional datasets (onet-full, esco-full) |
| `career data update` | Check for newer JobHop data on HuggingFace and recompute the transition matrix if available |

The `career path` output renders as an ASCII graph in the terminal showing transition chains and their relative frequency. This is a preview/lite version — directional, not definitive.

### Tier 3 — Validation (no AI)

| Command | Description |
|---|---|
| `career validate` | Lint the workspace: missing profile fields, stale opportunities, outdated skills, no recent brag entries |
| `career timeline` | ASCII timeline of career history and future goals from profile |

### Tier 4 — AI-Enhanced Features (requires API key)

These are additive flags or subcommands layered on Tier 1–3 features. All AI interactions are governed by the coaching policies in `data/coaching/`.

| Command | Description |
|---|---|
| `career brag reflect` | Send brag entries to LLM for pattern analysis, growth themes, and review talking points |
| `career opportunity parse <url>` | AI-assisted extraction of job posting into structured opportunity file |
| `career gap <opp> --suggest` | Ask LLM how to close identified skill gaps |
| `career compare <opp1> <opp2> --advise` | LLM-powered nuanced reasoning about trade-offs |
| `career chat` | Open-ended career coaching conversation, saved to `conversations/` |
| `career resume review` | LLM critique of latest resume against a target opportunity |

### Tier 5 — Vector Search (advanced, optional)

| Command | Description |
|---|---|
| `career memory enable` | Initialize LanceDB in `data/.vectordb/`, index existing content |
| `career memory search <query>` | Semantic search across brag entries, conversations, opportunities |
| `career chat` (enhanced) | AI coaching with full context retrieval from past sessions |

---

## MCP Integration

The tool exposes itself as an MCP server via FastMCP, enabling any MCP-compatible client (Claude Desktop, Cursor, custom agents) to interact with the career data programmatically.

### Architecture

```python
from fastmcp import FastMCP

mcp = FastMCP("career-planner")

@mcp.tool
def get_skills_inventory() -> dict:
    """Return the user's current skills inventory with ratings and examples."""
    ...

@mcp.tool
def get_opportunities(status: str = "active") -> list:
    """List career opportunities being tracked."""
    ...

@mcp.tool
def run_gap_analysis(opportunity: str) -> dict:
    """Run a skill gap analysis for a specific opportunity."""
    ...

@mcp.tool
def get_career_status() -> dict:
    """Get overall career planning status summary."""
    ...

@mcp.tool
def get_brag_entries(last: int = 10, tag: str = None) -> list:
    """Return recent achievement/brag entries."""
    ...

@mcp.tool
def get_job_criteria() -> dict:
    """Return the user's job criteria (function, culture, growth, compensation, location)."""
    ...

@mcp.tool
def check_criteria(opportunity: str) -> dict:
    """Check an opportunity against the user's job criteria and flag dealbreaker violations."""
    ...

@mcp.resource("career://profile")
def get_profile() -> str:
    """Read the user's career profile."""
    ...

@mcp.resource("career://brag/{date}")
def get_brag_entry(date: str) -> str:
    """Read a specific brag entry."""
    ...
```

### Notion Integration (via MCP chaining only)

The tool does NOT directly integrate with Notion — no Notion API client, no `NOTION_TOKEN` in config. Instead, it exposes structured data via MCP tools, and the official Notion MCP server (`@notionhq/notion-mcp-server`) handles the Notion side. An MCP client (like Claude Desktop) orchestrates both:

1. **Career Planner MCP** → exposes career data (skills, gaps, opportunities, brag entries, status)
2. **Notion MCP** → creates/updates Notion pages and databases

A user in Claude Desktop could say: *"Read my career status and create a tracking dashboard in Notion"* — Claude calls the career planner MCP for data, then the Notion MCP to build the dashboard.

Example MCP client configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "career-planner": {
      "command": "career",
      "args": ["mcp", "start"]
    },
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2025-09-03\"}"
      }
    }
  }
}
```

---

## Tech Stack

### Core (mandatory)

| Dependency | Purpose | Install size |
|---|---|---|
| Python 3.10+ | Runtime | (system) |
| Typer | CLI framework | ~1 MB |
| Rich | Terminal formatting, tables, trees | ~3 MB |
| PyYAML | Config and data file parsing | ~600 KB |
| httpx | HTTP client for LLM API calls | ~1 MB |

### AI Layer (opt-in, installed via `pip install career-planner[ai]`)

| Dependency | Purpose |
|---|---|
| httpx | Already in core; handles all LLM API calls via OpenAI-compatible endpoints |

### Vector Search (opt-in, installed via `pip install career-planner[memory]`)

| Dependency | Purpose |
|---|---|
| lancedb | Embedded vector database |
| sentence-transformers (or similar) | Local embeddings (if not using API embeddings) |

### MCP Server (opt-in, installed via `pip install career-planner[mcp]`)

| Dependency | Purpose |
|---|---|
| fastmcp | MCP server framework |

---

## Config File (config.yml)

```yaml
# Career Planner Configuration

# CLI interface language ("en" or "vi")
language: en

# LLM Provider (optional — tool works without this)
# Two providers are supported: "anthropic" and "openai-compatible".
# The openai-compatible shape covers OpenAI, Ollama (local + cloud),
# Together, Fireworks, OpenRouter, MiniMax, and most hosted gateways.
llm:
  provider: anthropic
  base_url: https://api.anthropic.com/v1
  api_key_env: ANTHROPIC_API_KEY           # env var name (never store keys in file)
  model: claude-sonnet-4-20250514
  #
  # Examples for other providers (replace the block above):
  #
  # Ollama Cloud (hosted, API key required):
  #   provider: openai-compatible
  #   base_url: https://ollama.com/v1       # verify in your dashboard
  #   api_key_env: OLLAMA_API_KEY
  #   model: gpt-oss:120b
  #
  # Local Ollama (no auth needed; omit api_key_env):
  #   provider: openai-compatible
  #   base_url: http://localhost:11434/v1
  #   model: llama3.1:8b
  #
  # MiniMax / OpenAI / OpenRouter etc. follow the same shape — set
  # base_url and model to whatever the provider publishes.
  
# Data preferences
data:
  taxonomy: esco           # primary: "esco" or "onet"
  language: en             # ESCO language code

# MCP Server
mcp:
  enabled: false
  transport: stdio         # or "sse", "streamable-http"
  port: 8000               # for HTTP transports

# Editor
editor: $EDITOR            # defaults to system $EDITOR, fallback to vim
```

---

## Getting Started (target user experience)

```bash
# Install
pip install career-planner

# Initialize workspace
cd ~/Documents
career init my-career
cd my-career

# Set up your profile
career profile edit          # opens profile.yml in editor

# Add your skills with real-world examples
career skills browse         # browse ESCO taxonomy interactively
career skills add "Python programming" --rating 4 \
    --example "Built data pipeline processing 2M records/day"
career skills add "Project management" --rating 3 \
    --example "Led 4-person team for semester capstone project"

# Track an opportunity (from title or URL)
career opportunity add "Senior Engineer at Acme Corp"
career opportunity add --url https://example.com/jobs/12345

# Check skill gaps
career gap senior-engineer-at-acme-corp

# Record an achievement when you finish something significant
career brag add

# See your status
career status

# (Optional) Enable AI coaching
export ANTHROPIC_API_KEY=sk-...
career chat

# (Optional) Explore career paths (works offline with bundled data)
career path --from "software developer" --to "product manager"
# Or with richer online data:
career path --from "software developer" --to "product manager" --online

# (Optional) Start MCP server for Notion integration
career mcp start

# (Optional) Use in Vietnamese
career init my-career --language vi
```

---

## Implementation Plan (Claude Code Sessions)

Implementation follows a phased approach using Claude Code CLI. Each session is scoped to stay under 40% of the context window (~80K tokens). Specs (this blueprint + man page) are referenced via `CLAUDE.md` and custom commands.

### Session 0 — Data Preparation (prerequisite, no Claude Code)

Before any implementation, prepare the bundled datasets:

1. Manually download ESCO v1.2.1 English CSV package from https://esco.ec.europa.eu/en/use-esco/download.
2. Download the ESCO ↔ O\*NET crosswalk CSV from https://www.onetcenter.org/crosswalks.html.
3. Write and run `scripts/prepare_esco.py` to filter and curate the ~1,000 tech-worker skills subset.
4. Write and run `scripts/prepare_onet_crosswalk.py` to filter the crosswalk to the curated subset.
5. Write and run `scripts/prepare_jobhop_matrix.py` to compute the transition probability matrix from HuggingFace REST API.
6. Commit all output YAML/CSV files to `src/career_planner/data/`.
7. Create the repo skeleton: `CLAUDE.md`, `pyproject.toml`, `src/career_planner/__init__.py`, `tests/`, `docs/` (with blueprint + man page).

This session can be done with Claude Code (asking it to write the scripts) or manually. The key output is: **bundled data files exist in the repo and are importable by the tool.**

Estimated context: ~35K tokens (script writing + testing against real CSV data).

### Session 1 — Scaffold, `career init`, and `career man`

Implement: `pyproject.toml` with entry points and optional extras `[ai,memory,mcp]`, Typer app skeleton with command group structure, `career init` command (creates workspace directory + copies templates), `career man` command (renders `docs/man.md` through Rich's pager, with `--no-pager` for piping), workspace discovery module (find workspace root from any subdirectory), config loading (`config.yml` parsing). Bundle `docs/man.md` into the wheel via `[tool.hatch.build.targets.wheel.force-include]` so the man page ships with the installed package.

End state: `pip install -e .` works, `career init my-career` produces a real workspace directory, and `career man` opens the manual.

Estimated context: ~26K tokens.

### Session 2 — Profile and skills

Implement: `career profile edit/show`, `career skills add/list/remove`, ESCO taxonomy loader (reads bundled YAML), fuzzy matching against ESCO skill labels, skill inventory YAML read/write (including `--rating` and `--example` fields), `career skills browse` (all three modes: hierarchy, `--search`, `--for`/`--vs`).

Estimated context: ~35K tokens.

### Session 3 — Brag document

Implement: `career brag add` (XYZ template, frontmatter parsing), `career brag list` (with `--last` and `--tag` filters), `career brag show`, `career brag summary` (plain-text summary generator by time period).

Estimated context: ~28K tokens.

### Session 4 — Opportunities and gap analysis

Implement: `career opportunity add` (title mode + `--url` mode with HTML extraction), `career opportunity list/show`, `career gap` (skills inventory vs. opportunity requirements comparison, table output).

Estimated context: ~42K tokens (heaviest pure-software session due to HTML parsing + gap logic).

### Session 5 — Status, validate, timeline

Implement: `career status` (Rich terminal dashboard), `career validate` (workspace linting), `career timeline` (ASCII timeline rendering).

Estimated context: ~30K tokens.

### Session 6 — Career paths

Implement: `career path` (load bundled transition matrix, ASCII graph rendering, `--online` mode via HuggingFace API), `career path explore` (interactive drill-down), `career compare` (weighted decision matrix), `career data download/update`.

Estimated context: ~38K tokens.

### Session 7 — i18n

Implement: wrap all user-facing strings in `_()`, generate `.pot` template, create Vietnamese `.po` translation, compile to `.mo`, add `language` config support, translate man page.

Estimated context: ~45K tokens (touches many files but each change is mechanical).

### Session 8 — AI layer

Implement: LLM adapter (supports OpenAI-compatible, Anthropic, Ollama), coaching system prompt loader with `{{variable}}` interpolation, policies loader, `career chat` (conversation loop, save to `conversations/`), all AI subcommands and flags: `--reflect`, `--suggest`, `--advise`, `career opportunity parse`, `career resume review`.

Estimated context: ~50K tokens. Consider splitting into two sessions (adapter + chat vs. enhancement flags) if context runs high.

### Session 9 — MCP server

Implement: FastMCP server exposing all tools and resources, `career mcp start` command with transport options.

Estimated context: ~34K tokens.

---

## Landscape & Related Projects

No existing tool combines local-first CLI, skill taxonomies, gap analysis, and AI coaching for individuals. The adjacent space includes:

- **career-open-source** (github.com/w0rd-driven/career-open-source) — Obsidian-based Markdown templates for career tracking. Right philosophy, but a template repo with no tooling or data.
- **career-ops** (github.com/career-ops/career-ops) — AI-powered job search automation (resume generation, job board scanning). Focused on active job hunting, not long-term planning. Requires Claude Code.
- **esco-skill-extractor** (github.com/KonstantinosPetrakis/esco-skill-extractor) — Python library that extracts ESCO skills from job postings using embeddings. Not an end-user tool, but a potential future integration for auto-populating opportunity files.
- **Nesta Skills Extractor** (github.com/nestauk/ojd_daps_skills) — Similar NLP library mapping job ad text to ESCO/Lightcast taxonomies.
- **Lightcast Open Skills** (lightcast.io/open-skills) — 32K+ skill taxonomy updated biweekly from job postings. A potential third taxonomy source alongside ESCO/O\*NET.

---

## Decisions Log

1. **Project name**: `career-planner`. There is a small existing GitHub repo (`sanatladkat/career-planner`) using the same name — a Streamlit web app, architecturally very different. The name is generic enough to share; no PyPI conflict exists. Alternative candidates if a rename is ever needed: `career-cli`, `careerkit`, `pathwise`, `waypoint`.
2. **Resume parsing**: v1 stores PDF resumes as-is in `resumes/` with YAML frontmatter for date and target role versioning. No PDF parsing in v1.
3. **ESCO subset**: Bundle a curated top ~1,000 skills focused on knowledge-worker / tech-worker roles. Full 13K taxonomy available via `career data download esco-full`.
4. **JobHop matrix**: Ship a pre-computed transition probability matrix (~1–2 MB YAML/JSON) as `transitions.yml` with an internal `version_date` field stamped from the JobHop dataset's `updated_at` metadata. The JobHop dataset is designed to be regularly updated by the Ghent University team, though on no fixed schedule. Include a `career data update` command that checks the HuggingFace dataset's `updated_at` metadata and recomputes the matrix from the REST API when a newer version is available.
5. **Plugin system**: Not needed for v1. MCP provides extensibility for external integrations. A formal plugin mechanism and community contribution structure are v2 concerns, informed by actual user demand.

---

## References & Data Sources

| Resource | URL | License |
|---|---|---|
| ESCO Classification | https://esco.ec.europa.eu | Free, European Commission |
| ESCO API (hosted + local) | https://esco.ec.europa.eu/en/about-esco/escopedia/escopedia/esco-api | Free |
| ESCO ↔ O\*NET Crosswalk | https://esco.ec.europa.eu/en/use-esco/other-crosswalks | Free |
| O\*NET Database | https://www.onetcenter.org/database.html | Creative Commons 4.0 |
| O\*NET Crosswalk Files | https://www.onetcenter.org/crosswalks.html | Creative Commons 4.0 |
| O\*NET Web Services API | https://services.onetcenter.org/reference/ | Free (registration required) |
| O\*NET on Kaggle | https://www.kaggle.com/datasets/emarkhauser/onet-29-0-database | CC |
| JobHop Dataset | https://huggingface.co/datasets/aida-ugent/JobHop | CC BY 4.0 |
| HuggingFace Datasets Server API | https://huggingface.co/docs/dataset-viewer/quick_start | Apache 2.0 |
| LinkedIn Career Explorer | https://linkedin.github.io/career-explorer/ | Check terms |
| FastMCP (Python MCP SDK) | https://github.com/modelcontextprotocol/python-sdk | MIT |
| Notion MCP Server (official) | https://developers.notion.com/guides/mcp/overview | Notion terms |
| ESCO ↔ O\*NET Technical Report | https://esco.ec.europa.eu/en/about-esco/publications/publication/crosswalk-between-esco-and-onet-technical-report | Free |
