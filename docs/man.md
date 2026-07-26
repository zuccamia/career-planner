# Career Planner Manual

## NAME

**career** — a local-first, CLI-based personal career planning tool

## SYNOPSIS

```
career <command> [<subcommand>] [options]
```

## DESCRIPTION

**career** stores all data as flat Markdown and YAML files on the local filesystem. Structured features (skills management, gap analysis, career paths) work offline; AI-enhanced features use a bring-your-own API key.

All commands operate on a **workspace** — a directory initialized with `career init`. Commands must run from within a workspace (or subdirectory).

i18n is via `gettext`. Set `language` in `config.yml` or the `LANGUAGE` env var. English (`en`) and Vietnamese (`vi`) ship in v1.

## COMMAND INDEX

| Section | Commands |
| --- | --- |
| WORKSPACE | `init`, `status`, `timeline`, `config llm`, `config llm test` |
| PROFILE | `profile edit`, `profile show` |
| JOB CRITERIA | `criteria edit`, `criteria show`, `criteria check` |
| BRAG | `brag add`, `brag list`, `brag show`, `brag reflect`, `brag summary` |
| RESUMES | `resume add`, `resume list`, `resume review` |
| OPPORTUNITIES | `opportunity add`, `opportunity parse`, `opportunity list`, `opportunity show` |
| SKILLS | `skills list`, `skills add`, `skills remove`, `skills browse` |
| GAP ANALYSIS | `gap` |
| CAREER PATHS | `path`, `path explore` |
| AI CHAT | `chat` |
| DATA | `data download`, `data update` |
| VECTOR SEARCH | `memory enable`, `memory search` |
| MCP SERVER | `mcp start` |

Commands marked *(AI)* require a configured LLM provider.

## COMMANDS

### WORKSPACE

**career init** [*directory*]

:   Initialize a new workspace. Creates starter templates for `profile.yml`, `config.yml`, `criteria.yml`, `skills/inventory.yml`, and copies the bundled ESCO subset, JobHop matrix, and AI coaching files into `data/`. Defaults to current directory.

**career status**

:   Terminal dashboard: active opportunities, days since last brag, skills coverage, upcoming deadlines, profile completeness. Also surfaces workspace warnings inline — missing/empty profile fields, opportunities with no status update in 30+ days, skills inventory not updated in 6+ months, no brag entries in the last quarter, resumes with no YAML sidecar, and orphaned files.

**career timeline**

:   ASCII timeline of career history (from `profile.yml`) and future goals. Past roles with durations; future targets with dates if set.

**career config llm**

:   Interactively configure the LLM provider. Walks the user through a preset list — Anthropic Console, Ollama Cloud, Local Ollama, OpenAI, OpenRouter, or Custom (openai-compatible) — and prompts for `base_url`, `model`, and the name of the env var holding the API key (blank for local Ollama). Rewrites the `llm:` block in `config.yml`, preserving comments and other sections.

    The API key itself is never read or stored — only the env var *name*. If the variable is already exported (or the provider needs no key), the wizard sends a small "ping" to verify; otherwise it prints the expected `export` line and points at `career config llm test`.

**career config llm test**

:   Re-runnable connection check. Resolves the API key from `api_key_env` (or skips when no key is required) and sends a short "say ok" prompt. Exits **3** when the LLM is not configured (missing block/field, unbound env var) and **1** on provider errors (HTTP, malformed body, network) — the failure message includes the provider's diagnostic snippet.

### PROFILE

**career profile edit** [**--editor**]

:   Walk through the profile field by field. Current values shown as defaults — press Enter to keep. List fields take comma-separated entries; `-` clears a list. Existing history is preserved; you're prompted to append new past roles.

    **--editor**
    :   Skip prompts; open `profile.yml` in `$EDITOR` (or `editor:` in `config.yml`, fallback `vim`).

**career profile show**

:   Print a formatted profile summary.

### JOB CRITERIA

The criteria file captures preferences and dealbreakers across five dimensions: **function**, **culture**, **growth**, **compensation**, **location**.

**career criteria edit** [**--editor**]

:   Walk through criteria dimension by dimension. Current values as defaults, list fields are comma-separated, `-` clears.

    **--editor**
    :   Open `criteria.yml` directly. Useful for bulk edits or preserving comments.

**career criteria show**

:   Print a formatted criteria summary, highlighting empty or incomplete dimensions.

**career criteria check** *opportunity* [**--reason**]

:   Compare a tracked opportunity against criteria. Flags dealbreaker violations and scores alignment across all five dimensions. Pure software — no AI required. Distinct from `career gap`, which checks skills.

    **--reason** *(AI)*
    :   Augment with LLM reasoning to catch violations that literal matching missed (e.g. a description that *implies* "no coding at all" without the exact phrase), plus a per-dimension summary and overall verdict. LLM-surfaced violations are tagged `llm`; pure-software violations keep their original tags (`dealbreaker`, `salary_floor`, `work_type`). Network/parse failures fall back to the pure-software result with a warning. Exits **3** if no provider configured.

### BRAG

An achievements log, not a daily journal — record entries when you ship something significant. Recommended cadence: at least once per quarter or semester. Inspired by Julia Evans' brag documents and Google's XYZ format ("Accomplished [X] as measured by [Y] by doing [Z]").

**career brag add** [**--date** *YYYY-MM-DD*]

:   Open the editor with an XYZ-format template (frontmatter: `date`, `project`, `tags`; sections: What/X, How measured/Y, How done/Z, Skills demonstrated, Notes).

    **--date** *YYYY-MM-DD*
    :   Override the entry date. Defaults to today.

**career brag list** [**--last** *N*] [**--tag** *tag*]

:   List entries by date. Defaults to the 10 most recent.

**career brag show** *entry*

:   Print the full details of a brag entry.

**career brag reflect** *(AI)*

:   Send brag entries (optionally filtered by `--last`/`--tag`) to the LLM for pattern analysis — themes, growth areas, underrepresented skills, performance-review talking points. Optionally saved to `assessments/`.

**career brag summary** [**--period** *period*]

:   Plain-text accomplishment summary for sharing with a manager. No AI.

    **--period** *period*
    :   `quarter` (default), `half`, `year`, `all`.

### RESUMES

**career resume add** *file*

:   Copy a resume PDF into `resumes/` and create a YAML sidecar prompting for metadata (`filename`, `date`, `target_role`, `opportunity` slug, `version`, `notes`). The `opportunity` field is the inverse of an opportunity's `attachments:` entry — `career resume list` uses it to show which opportunity each version was tailored for, and the MCP server uses it to surface the right file when exporting.

**career resume list**

:   List stored resumes with metadata (date, target role, version).

**career resume review** [**--for** *opportunity*] *(AI)*

:   Send the latest resume to the LLM for critique. With `--for`, the review is tailored to that opportunity.

### OPPORTUNITIES

**career opportunity add** [*title*] [**--url** *url*] [**--no-editor**]

:   Create an opportunity file. Either *title* or `--url` must be provided. The editor opens to a Markdown template with frontmatter (role, company, location, work type, URL, salary range, status, posted date, deadline, applied date, created date, attachments, required skills) and body sections (description, pros, cons, notes).

    **--url** *url*
    :   Fetch the page and run a layered, best-effort structural extraction:

        1. **Schema.org `JobPosting` JSON-LD** — richest source, embedded in most reputable boards (Microsoft, Greenhouse, Lever, Workday, LinkedIn). Populates role, company, location, dates, work_type (when `TELECOMMUTE`), salary, and a plain-text description.
        2. **Open Graph + standard meta tags** — `og:title`, `og:site_name`, `og:description` fallback.
        3. **`<title>` element** — last-resort title only.

        Fetch failures still create the file with the URL recorded and a warning. SPA-only sites that don't pre-render anything produce a near-empty file — use `opportunity parse` for those.

    **--no-editor**
    :   Skip opening the editor. Useful for scripting/tests.

**career opportunity parse** *url* [**--title** *text*] [**--no-editor**] *(AI)*

:   Create an opportunity by asking the LLM to extract the full field set in a single pass — title, role, company, location, work_type, dates, salary, required_skills, description. The deterministic JSON-LD / Open Graph extractor is **not** consulted on the happy path; the LLM reads the stripped page directly.

    Exits **3** if no LLM provider is configured. Network/API/JSON-parse failures print a warning and **fall back to the deterministic extractor** (`extract_job_posting`) so the file is still populated with whatever JSON-LD / Open Graph fields the page exposes.

    **--title** *text*
    :   Override the extracted title (the `role` field is cleared so the two don't drift).

    **--no-editor**
    :   Skip opening the editor.

**career opportunity list** [**--status** *status*]

:   List tracked opportunities (all by default).

    **--status** *status*
    :   Free-form match (case-insensitive). Suggested values: `active`, `applied`, `interviewing`, `offered`, `rejected`, `closed`, `withdrawn`. You can also use your own labels (`OA`, `first interview`, `recruiter screen`, etc.) — `career status` treats anything other than `closed`, `rejected`, or `withdrawn` as an open opportunity.

**career opportunity show** *opportunity*

:   Print the full details. Matches against slugs in `opportunities/` (exact slug wins, then substring match on slug or title; a disambiguation prompt is shown if more than one matches).

### SKILLS

**career skills list** [**--category** *category*]

:   Display the inventory with self-ratings, one-line examples, ESCO codes.

    **--category** *category*
    :   Filter by ESCO category (e.g. `digital`, `communication`, `leadership`).

**career skills add** *skill* [**--rating** *N*] [**--example** *text*]

:   Add a skill. *skill* is fuzzy-matched against the bundled ESCO taxonomy; multiple matches prompt to pick. No match → stored with a user-defined label and no ESCO code.

    **--rating** *N* — 1 (beginner) to 5 (expert). Prompted if omitted.
    **--example** *text* — one-line real-world example. Prompted if omitted. e.g. `--example "Built a CI/CD pipeline serving 50 microservices at Acme Corp"`.

**career skills remove** *skill*

:   Remove a skill from the inventory.

**career skills browse** [**--search** *keyword* | **--for** *occupation* [**--vs** *occupation*]]

:   Explore the bundled ESCO taxonomy. With no flags, prints the skill hierarchy as a Rich tree — static and printable, no arrow-key navigation in v1. Skills not in the hierarchy file are only reachable via `--search`.

    **--search** *keyword*
    :   Fuzzy-search labels and descriptions. Returns a ranked table with type (knowledge vs. skill/competence) and a description snippet. The most practical way to translate informal language into taxonomy terms (e.g. `--search "client communication"`). Pair with `career skills add "<name>"` to record.

    **--for** *occupation*
    :   Skill profile for an ESCO occupation, grouped by type. Useful for exploring unfamiliar fields or building a gap-analysis target.

    **--vs** *occupation*
    :   Used with `--for`. Side-by-side comparison: overlapping skills, unique to first, unique to second. Useful for identifying bridge skills in a transition.

### GAP ANALYSIS

**career gap** *opportunity* [**--suggest**]

:   Compare the user's skills inventory against the opportunity's required skills. Outputs matched (with examples), missing, and partial matches (skill present but lower rating than expected). *opportunity* matches filenames in `opportunities/` (without extension).

    **--suggest** *(AI)*
    :   Send results to the LLM for gap-closing suggestions (courses, projects, certifications).

### CAREER PATHS

**career path** [**--from** *role*] [**--to** *role*] [**--online**]

:   Show common transition paths between ESCO occupations from the bundled JobHop matrix. Rendered as an ASCII graph with relative frequency. `--from` defaults to current role in `profile.yml`; `--to` defaults to most common next steps.

    **--from** *role*, **--to** *role*
    :   Fuzzy-matched against ESCO occupation titles. With both, shows the most common multi-step paths.

    **--online**
    :   Query the HuggingFace Datasets Server REST API for deeper or less common lookups beyond the bundled matrix. Requires internet.

**career path explore**

:   Interactive mode from the current role. Drill into next-step occupations with arrow keys + Enter.

### AI CHAT

**career chat** *(AI)*

:   Open-ended coaching conversation, contextualized with profile, skills, active opportunities, recent brag entries, and criteria. Session saved to `conversations/` as a timestamped Markdown file. Governed by `data/coaching/system-prompt.md` and `data/coaching/policies.md` (user-editable). If vector search is enabled, retrieves relevant context from past sessions. `/quit` or Ctrl-D ends the session.

### DATA MANAGEMENT

**career data download** *dataset*

:   Download optional datasets:

    *esco-full* — Full ESCO taxonomy (~13,000 skills, all occupations, all languages).
    *onet-full* — Full O\*NET (923+ occupations, all skill/knowledge/ability descriptors).

**career data update**

:   Check for a newer JobHop dataset. If found, recompute the transition matrix and update the bundled file. Prints current and latest version dates.

### VECTOR SEARCH (ADVANCED)

**career memory enable**

:   Initialize LanceDB in `data/.vectordb/` and index existing content (brag, conversations, opportunities, profile). New content is indexed automatically. Requires `career-planner[memory]`.

**career memory search** *query*

:   Semantic search across indexed content. Returns ranked snippets with source paths.

### MCP SERVER

**career mcp start** [**--transport** *transport*] [**--port** *port*]

:   Start the planner as an MCP server, exposing workspace data and tools to MCP clients (Claude Desktop, Cursor, custom agents).

    **--transport** *transport* — `stdio` (default), `sse`, `streamable-http`.
    **--port** *port* — for HTTP-based transports. Default `8000`.

    See NOTION INTEGRATION for an example of orchestrating with another MCP server.

## NOTION INTEGRATION

The career planner integrates with Notion exclusively via MCP — the tool does **not** embed any Notion API client. To use Notion:

1. Run the career planner MCP server (`career mcp start`).
2. Run the official Notion MCP server (`@notionhq/notion-mcp-server`).
3. Use an MCP client (Claude Desktop, Cursor) to orchestrate between them.

Example `claude_desktop_config.json`:

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

## CONFIGURATION

Workspace settings live in `config.yml`:

| Key | Purpose |
| --- | --- |
| `llm.provider` | `anthropic` or `openai-compatible` (covers OpenAI, Ollama local/cloud, Together, Fireworks, OpenRouter, MiniMax, and any OpenAI-Chat-Completions gateway). |
| `llm.base_url` | API endpoint. Required for `openai-compatible`; defaults to `https://api.anthropic.com/v1` for `anthropic`. |
| `llm.api_key_env` | Env var *name* holding the key (keys never stored in files). Required for `anthropic`; optional for `openai-compatible` (omit for local Ollama — request goes without `Authorization`). |
| `llm.model` | Model identifier (e.g. `claude-sonnet-4-20250514`, `gpt-4o`, `llama3.1:8b`). |
| `data.taxonomy` | `esco` (default) or `onet`. |
| `data.language` | ESCO language code (default `en`). Applies when using the full ESCO dataset. |
| `language` | CLI language: `en` (default) or `vi`. Also via `LANGUAGE` env var. |
| `editor` | Editor command. Defaults to `$EDITOR`, fallback `vim`. |

## ENVIRONMENT

**EDITOR** — Editor for `brag add`, `profile edit`, `opportunity add`.
**LANGUAGE** — CLI language override (`en`, `vi`).
**ANTHROPIC_API_KEY**, **OPENAI_API_KEY**, etc. — API key for AI features. The env var name is configurable via `llm.api_key_env`.

## FILES

```
my-career/
├── config.yml              Configuration
├── profile.yml             Career profile
├── criteria.yml            Job criteria (5 dimensions)
├── skills/inventory.yml    Skills inventory (ESCO-coded, with examples)
├── brag/YYYY-MM-DD-*.md    Achievement entries (XYZ format)
├── resumes/                Resume PDFs + .yml metadata sidecars
├── opportunities/*.md      Tracked opportunities
├── assessments/*.md        Decision frameworks and analysis
├── conversations/*.md      Saved AI coaching sessions
├── data/
│   ├── coaching/           AI coaching system-prompt.md + policies.md (editable)
│   ├── esco-skills.yml     Bundled ESCO subset (~1,000 skills)
│   ├── esco-occupations.yml
│   ├── transitions.yml     Pre-computed JobHop matrix
│   ├── crosswalk.csv       ESCO ↔ O*NET mapping
│   ├── .vectordb/          LanceDB (if memory enabled)
│   └── cache/              Cached API responses
└── locale/<lang>/LC_MESSAGES/career.mo   Translations
```

## INTERNATIONALIZATION

i18n via Python `gettext`. English source; Vietnamese (`vi`) ships in v1. Translatable surfaces: CLI strings, help, errors, templates, this man page. Translation files in `locale/<lang>/LC_MESSAGES/` — create a `.po` from the provided `.pot` template and compile with `msgfmt`.

ESCO labels exist in 25 EU languages but not Vietnamese. With `language: vi`, the CLI is in Vietnamese while taxonomy labels remain in the user's chosen ESCO language (default English).

## INSTALLATION

```
pip install career-planner               # core (no AI)
pip install career-planner[ai]           # AI features
pip install career-planner[memory]       # vector search
pip install career-planner[mcp]          # MCP server
pip install career-planner[ai,memory,mcp]  # everything
```

Requires Python 3.10+.

## EXIT CODES

**0** Success. **1** General error. **2** Workspace not found. **3** Missing configuration (e.g. AI command with no provider).

## EXAMPLES

Initialize and set up a profile:

    $ career init my-career
    $ cd my-career
    $ career profile edit

Add skills with real-world examples:

    $ career skills browse --search "client communication"
    $ career skills add "Python programming" --rating 4 \
        --example "Built data pipeline processing 2M records/day"
    $ career skills list

Explore the taxonomy by occupation:

    $ career skills browse --for "data engineer"
    $ career skills browse --for "software developer" --vs "data scientist"

Record an achievement:

    $ career brag add

Set up job criteria and check an opportunity:

    $ career criteria edit
    $ career criteria check staff-engineer-at-acme-corp

Track an opportunity and check skill gaps:

    $ career opportunity add "Staff Engineer at Acme Corp"
    $ career opportunity add --url https://example.com/jobs/12345
    $ career gap staff-engineer-at-acme-corp

Explore career transition paths:

    $ career path --from "software developer" --to "product manager"
    $ career path explore

Quarterly brag summary:

    $ career brag summary --period quarter

AI coaching session:

    $ export ANTHROPIC_API_KEY=sk-ant-...
    $ career chat

Vietnamese interface:

    $ career init my-career --language vi
    # or set in config.yml: language: vi

## AUTHORS

Career Planner is an open-source project.

## BUGS

Report issues at the project's GitHub repository.

## SEE ALSO

**esco**(7) — European Skills, Competences, Qualifications and Occupations classification.
**onet**(7) — O\*NET Occupational Information Network.
Julia Evans, "Get your work recognized: write a brag document" — https://jvns.ca/blog/brag-documents/
Google XYZ Resume Format — "Accomplished [X] as measured by [Y] by doing [Z]."